import type { BillingOverview } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { z } from "zod";
import { recordAudit, requireAuth } from "../../../../src/auth/authorization";
import { DEFAULT_PAY_INSTRUCTIONS, ensureOpenInvoice, invoiceInclude, paymentInclude, refreshSubscription, summarize, toInvoiceSummary, toPaymentSummaries, toPlanSummary } from "../../../../src/billing/subscriptions";
import { configuredProviders } from "../../../../src/billing/providers";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";
import { parseBody } from "../../../../src/lib/validation";

const renewSchema = z.object({ period: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]), planCode: z.string().trim().min(1).optional() });

export function OPTIONS(request: Request): Response { return corsOptions(request); }

async function overview(organisationId: string): Promise<BillingOverview | null> {
  const subscription = await refreshSubscription(organisationId);
  if (!subscription) return null;
  const [invoices, payments, plans] = await Promise.all([
    db.subscriptionInvoice.findMany({ where: { organisationId, status: { not: "VOID" } }, include: invoiceInclude, orderBy: { issuedAt: "desc" }, take: 24 }),
    db.subscriptionPayment.findMany({ where: { organisationId, status: "SUCCEEDED" }, include: paymentInclude, orderBy: { receivedAt: "desc" }, take: 50 }),
    db.plan.findMany({ where: { isActive: true }, orderBy: { monthlyPrice: "asc" } })
  ]);
  return {
    subscription: summarize(subscription), invoices: invoices.map(toInvoiceSummary), payments: await toPaymentSummaries(payments), plans: plans.map(toPlanSummary),
    onlineMethods: configuredProviders(), payInstructions: process.env.PHARMICA_PAY_INSTRUCTIONS || DEFAULT_PAY_INSTRUCTIONS
  };
}

/** The owner subscription: plan, status, what is paused, invoices, and payment history. Available in every state. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner"]);
  if ("response" in access) return withCors(access.response, request);
  const body = access.user.organisationId ? await overview(access.user.organisationId) : null;
  if (!body) return withCors(apiError(404, "SUBSCRIPTION_NOT_FOUND", "This pharmacy has no subscription yet. Contact Pharmica."), request);
  return withCors(Response.json(body, { headers: { "x-api-version": "v1" } }), request);
}

/** The owner chooses how to renew (monthly, quarterly, or yearly, and optionally a bigger or smaller plan); the open invoice follows. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner"]);
  if ("response" in access) return withCors(access.response, request);
  const organisationId = access.user.organisationId;
  if (!organisationId) return withCors(apiError(403, "FORBIDDEN", "No pharmacy"), request);
  const body = await parseBody(request, renewSchema);
  if ("response" in body) return withCors(body.response, request);

  const plan = body.data.planCode ? await db.plan.findFirst({ where: { code: body.data.planCode, isActive: true } }) : null;
  if (body.data.planCode && !plan) return withCors(apiError(400, "PLAN_NOT_FOUND", "Choose an available plan"), request);
  if (plan) {
    const [branches, devices] = await Promise.all([db.branch.count({ where: { organisationId } }), db.device.count({ where: { branch: { organisationId }, isActive: true } })]);
    if ((plan.maxBranches != null && branches > plan.maxBranches) || (plan.maxDevices != null && devices > plan.maxDevices)) {
      return withCors(apiError(400, "PLAN_TOO_SMALL", `${plan.name} allows ${plan.maxBranches ?? "any number of"} branches and ${plan.maxDevices ?? "any number of"} counters. Deactivate some first, or choose a bigger plan.`), request);
    }
  }
  const invoice = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Subscription" WHERE "organisationId" = ${organisationId} FOR UPDATE`;
    const subscription = await tx.subscription.findUnique({ where: { organisationId }, include: { plan: true } });
    if (!subscription || subscription.cancelledAt) return null;
    return ensureOpenInvoice(tx, subscription, new Date(), { period: body.data.period, plan: plan ?? undefined, actorId: access.user.id });
  });
  if (!invoice) return withCors(apiError(400, "CANNOT_RENEW", "This subscription cannot be renewed here. Contact Pharmica."), request);
  await recordAudit({ organisationId, userId: access.user.id, action: "subscription.renewal_chosen", entityType: "invoice", entityId: invoice.id, metadata: { period: body.data.period, plan: plan?.code ?? null } });
  return withCors(Response.json(await overview(organisationId), { headers: { "x-api-version": "v1" } }), request);
}
