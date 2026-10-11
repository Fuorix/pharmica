import { db } from "@pharmica/database/client";
import { z } from "zod";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../src/admin/http";
import { matchPayment, paymentInclude, recordPayment, toPaymentSummaries } from "../../../../../src/billing/subscriptions";
import { apiError } from "../../../../../src/lib/api-response";
import { money, optionalTrimmed, parseBody, trimmed } from "../../../../../src/lib/validation";

const recordSchema = z.object({
  invoiceId: z.string().min(1),
  amount: money.refine((value) => value > 0, "Amount must be more than zero"),
  method: z.enum(["CASH", "BANK_TRANSFER"]),
  /** The receipt book number or bank reference given to the shop. */
  reference: trimmed(80),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
  note: optionalTrimmed(300)
});
const matchSchema = z.object({ paymentId: z.string().min(1), invoiceId: z.string().min(1) });

export const OPTIONS = OPTIONS_HANDLER;

export async function GET(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  const payments = await db.subscriptionPayment.findMany({
    where: { ...(status === "UNMATCHED" || status === "FAILED" || status === "SUCCEEDED" ? { status } : {}), ...(params.get("organisationId") ? { organisationId: params.get("organisationId") } : {}) },
    include: paymentInclude, orderBy: { receivedAt: "desc" }, take: 200
  });
  return json(request, { payments: await toPaymentSummaries(payments) });
}

/** Records cash or a bank transfer against an invoice. The receipt reference shows in the shop payment history. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const body = await parseBody(request, recordSchema);
  if ("response" in body) return withCors(body.response, request);
  const invoice = await db.subscriptionInvoice.findUnique({ where: { id: body.data.invoiceId }, include: { payments: true } });
  if (!invoice || invoice.status !== "OPEN") return withCors(apiError(400, "INVOICE_NOT_OPEN", "That invoice is not open for payment"), request);
  const balance = Number(invoice.total) - invoice.payments.filter((payment) => payment.status === "SUCCEEDED").reduce((sum, payment) => sum + Number(payment.amount), 0);
  if (body.data.amount > balance + 0.005) return withCors(apiError(400, "OVERPAYMENT", `Only PKR ${balance.toFixed(2)} is due on ${invoice.number}`), request);
  const result = await recordPayment({ organisationId: invoice.organisationId, invoiceId: invoice.id, method: body.data.method, amount: body.data.amount, reference: body.data.reference, note: body.data.note, recordedById: access.user.id, receivedAt: body.data.receivedAt ? new Date(body.data.receivedAt) : undefined });
  await db.auditLog.create({ data: { organisationId: invoice.organisationId, userId: access.user.id, action: "subscription.payment_recorded", entityType: "payment", entityId: result.payment.id, metadata: { invoice: invoice.number, amount: body.data.amount, method: body.data.method, reference: body.data.reference, applied: result.applied } } });
  const [payment] = await toPaymentSummaries([await db.subscriptionPayment.findUniqueOrThrow({ where: { id: result.payment.id }, include: paymentInclude })]);
  return json(request, { payment, invoicePaid: result.applied, paidThrough: result.subscription?.paidThrough.toISOString() ?? null }, 201);
}

/** Matches an online payment kept as UNMATCHED to the invoice it was meant for. */
export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const body = await parseBody(request, matchSchema);
  if ("response" in body) return withCors(body.response, request);
  const result = await matchPayment(body.data.paymentId, body.data.invoiceId, access.user.id);
  if ("error" in result) return withCors(apiError(400, "PAYMENT_NOT_MATCHED", result.error!), request);
  await db.auditLog.create({ data: { organisationId: result.invoice.organisationId, userId: access.user.id, action: "subscription.payment_matched", entityType: "payment", entityId: body.data.paymentId, metadata: { invoiceId: body.data.invoiceId, applied: result.applied } } });
  return json(request, { matched: true, invoicePaid: result.applied });
}
