import { db } from "@pharmica/database/client";
import { z } from "zod";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../src/admin/http";
import { invoiceInclude, toInvoiceSummary } from "../../../../../src/billing/subscriptions";
import { apiError } from "../../../../../src/lib/api-response";
import { parseBody, trimmed } from "../../../../../src/lib/validation";

const voidSchema = z.object({ invoiceId: z.string().min(1), reason: trimmed(300) });

export const OPTIONS = OPTIONS_HANDLER;

export async function GET(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  const invoices = await db.subscriptionInvoice.findMany({
    where: { ...(status === "OPEN" || status === "PAID" || status === "VOID" ? { status } : {}), ...(params.get("organisationId") ? { organisationId: params.get("organisationId")! } : {}) },
    include: invoiceInclude, orderBy: { issuedAt: "desc" }, take: 200
  });
  return json(request, { invoices: invoices.map(toInvoiceSummary) });
}

/** Voids an open invoice issued by mistake. An invoice with money on it cannot be voided. Never deleted. */
export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const body = await parseBody(request, voidSchema);
  if ("response" in body) return withCors(body.response, request);
  const invoice = await db.subscriptionInvoice.findUnique({ where: { id: body.data.invoiceId }, include: { payments: true } });
  if (!invoice || invoice.status !== "OPEN") return withCors(apiError(400, "INVOICE_NOT_OPEN", "Only an open invoice can be voided"), request);
  if (invoice.payments.some((payment) => payment.status === "SUCCEEDED")) return withCors(apiError(400, "INVOICE_HAS_PAYMENTS", "Money was paid on this invoice; it cannot be voided"), request);
  await db.$transaction([
    db.subscriptionInvoice.update({ where: { id: invoice.id }, data: { status: "VOID", voidedAt: new Date(), voidReason: body.data.reason } }),
    db.subscriptionEvent.create({ data: { subscriptionId: invoice.subscriptionId, type: "invoice_voided", actorId: access.user.id, reason: `${invoice.number}: ${body.data.reason}` } }),
    db.auditLog.create({ data: { organisationId: invoice.organisationId, userId: access.user.id, action: "subscription.invoice_voided", entityType: "invoice", entityId: invoice.id, metadata: { number: invoice.number, reason: body.data.reason } } })
  ]);
  return json(request, { invoice: toInvoiceSummary(await db.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoice.id }, include: invoiceInclude })) });
}
