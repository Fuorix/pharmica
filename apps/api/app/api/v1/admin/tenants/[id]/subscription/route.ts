import { db } from "@pharmica/database/client";
import { z } from "zod";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../../../src/admin/http";
import { tenantDetail } from "../../../../../../../src/admin/tenants";
import { changeSubscription, ensureOpenInvoice } from "../../../../../../../src/billing/subscriptions";
import { apiError } from "../../../../../../../src/lib/api-response";
import { parseBody, trimmed } from "../../../../../../../src/lib/validation";

type Context = { params: Promise<{ id: string }> };

const changeSchema = z.object({
  planCode: z.string().trim().min(1).optional(),
  period: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]).optional(),
  /** Extra days, e.g. a promise to pay by a date. */
  extendDays: z.number().int().min(1).max(90).optional(),
  cancel: z.boolean().optional(),
  reactivate: z.boolean().optional(),
  reason: trimmed(300)
}).refine((change) => change.planCode || change.period || change.extendDays || change.cancel || change.reactivate, "Nothing to change");

const invoiceSchema = z.object({ period: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]).optional() });

export const OPTIONS = OPTIONS_HANDLER;

/** Changes a subscription by hand. Every change needs a reason and is kept in the subscription history. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const body = await parseBody(request, changeSchema);
  if ("response" in body) return withCors(body.response, request);
  const plan = body.data.planCode ? await db.plan.findFirst({ where: { code: body.data.planCode, isActive: true } }) : null;
  if (body.data.planCode && !plan) return withCors(apiError(400, "PLAN_NOT_FOUND", "Choose an active plan"), request);
  if (plan) {
    const [branches, devices] = await Promise.all([db.branch.count({ where: { organisationId: id } }), db.device.count({ where: { branch: { organisationId: id }, isActive: true } })]);
    if ((plan.maxBranches != null && branches > plan.maxBranches) || (plan.maxDevices != null && devices > plan.maxDevices)) {
      return withCors(apiError(400, "PLAN_TOO_SMALL", `${plan.name} allows ${plan.maxBranches ?? "any number of"} branches and ${plan.maxDevices ?? "any number of"} counters; this pharmacy uses ${branches} and ${devices}`), request);
    }
  }
  const changed = await changeSubscription(id, { planId: plan?.id, period: body.data.period, extendDays: body.data.extendDays, cancel: body.data.cancel, reactivate: body.data.reactivate, reason: body.data.reason, actorId: access.user.id });
  if (!changed) return withCors(apiError(404, "SUBSCRIPTION_NOT_FOUND", "This pharmacy has no subscription"), request);
  await db.auditLog.create({ data: { organisationId: id, userId: access.user.id, action: "subscription.changed", entityType: "subscription", entityId: changed.id, metadata: body.data } });
  return json(request, { tenant: await tenantDetail(id) });
}

/** Issues the renewal invoice now (for the given billing period), e.g. when a shop asks to pay early. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const body = await parseBody(request, invoiceSchema);
  if ("response" in body) return withCors(body.response, request);
  const issued = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Subscription" WHERE "organisationId" = ${id} FOR UPDATE`;
    const subscription = await tx.subscription.findUnique({ where: { organisationId: id }, include: { plan: true } });
    return subscription ? ensureOpenInvoice(tx, subscription, new Date(), { period: body.data.period, actorId: access.user.id }) : null;
  });
  if (!issued) return withCors(apiError(404, "SUBSCRIPTION_NOT_FOUND", "This pharmacy has no subscription"), request);
  return json(request, { tenant: await tenantDetail(id) }, 201);
}
