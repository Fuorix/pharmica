import { db, type Prisma } from "@pharmica/database/client";
import { z } from "zod";
import { isProvider, PROVIDERS, SIGNATURE_HEADER, verifySignature } from "../../../../../../src/billing/providers";
import { recordPayment } from "../../../../../../src/billing/subscriptions";
import { apiError } from "../../../../../../src/lib/api-response";
import { logError } from "../../../../../../src/lib/logger";

type Context = { params: Promise<{ id: string }> };

const callbackSchema = z.object({
  transactionId: z.string().trim().min(1).max(120),
  invoiceNumber: z.string().trim().min(1).max(40),
  amount: z.number().positive().finite(),
  status: z.enum(["SUCCESS", "FAILED"]),
  paidAt: z.iso.datetime({ offset: true }).optional()
});

const ok = (body: Record<string, unknown>) => Response.json(body, { headers: { "x-api-version": "v1" } });

/**
 * A payment provider tells us a shop paid. Server to server: no session, no CORS. The signature proves it came from
 * the provider; the transaction ID makes repeats harmless; the invoice number and amount must match an open invoice
 * exactly, or the money is kept as UNMATCHED for staff to sort out. Every accepted callback gets a 200 so the
 * provider stops retrying; only a bad signature or malformed body is refused.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  if (!isProvider(id)) return apiError(404, "UNKNOWN_PROVIDER", "Unknown payment provider");
  const raw = await request.text();
  if (!verifySignature(id, raw, request.headers.get(SIGNATURE_HEADER))) {
    await db.auditLog.create({ data: { action: "billing.callback_rejected", entityType: "payment_provider", entityId: id, metadata: { reason: "bad or missing signature" } } });
    return apiError(401, "INVALID_SIGNATURE", "The signature does not match");
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return apiError(400, "INVALID_JSON", "The body must be JSON"); }
  const parsed = callbackSchema.safeParse(json);
  if (!parsed.success) return apiError(400, "INVALID_CALLBACK", parsed.error.issues[0]?.message ?? "Malformed callback");
  const callback = parsed.data;
  const method = PROVIDERS[id];

  const existing = await db.subscriptionPayment.findUnique({ where: { method_providerTransactionId: { method, providerTransactionId: callback.transactionId } } });
  if (existing) return ok({ received: true, duplicate: true, paymentId: existing.id, status: existing.status });

  const invoice = await db.subscriptionInvoice.findUnique({ where: { number: callback.invoiceNumber }, include: { payments: true } });
  const balance = invoice ? Number(invoice.total) - invoice.payments.filter((payment) => payment.status === "SUCCEEDED").reduce((sum, payment) => sum + Number(payment.amount), 0) : 0;
  const matches = invoice?.status === "OPEN" && Math.abs(balance - callback.amount) < 0.005;
  const status = callback.status === "FAILED" ? "FAILED" : matches ? "SUCCEEDED" : "UNMATCHED";
  const note = callback.status === "FAILED" ? "Provider reported a failed payment"
    : !invoice ? `Unknown invoice ${callback.invoiceNumber}`
    : invoice.status !== "OPEN" ? `Invoice ${invoice.number} is ${invoice.status.toLowerCase()}`
    : !matches ? `Amount ${callback.amount} does not match the ${balance.toFixed(2)} due` : null;

  try {
    const result = await recordPayment({
      organisationId: invoice?.organisationId ?? null, invoiceId: status === "SUCCEEDED" ? invoice!.id : null, method, amount: callback.amount, status,
      reference: callback.transactionId, providerTransactionId: callback.transactionId, note, raw: callback as unknown as Prisma.InputJsonValue,
      receivedAt: callback.paidAt ? new Date(callback.paidAt) : undefined
    });
    await db.auditLog.create({ data: { organisationId: invoice?.organisationId, action: "billing.callback_received", entityType: "payment", entityId: result.payment.id, metadata: { provider: id, invoice: callback.invoiceNumber, amount: callback.amount, status, applied: result.applied } } });
    return ok({ received: true, paymentId: result.payment.id, status, applied: result.applied });
  } catch (error) {
    // Two deliveries of the same callback at once: the unique (method, transaction) key lets only one in.
    if ((error as { code?: string }).code === "P2002") {
      const again = await db.subscriptionPayment.findUnique({ where: { method_providerTransactionId: { method, providerTransactionId: callback.transactionId } } });
      return ok({ received: true, duplicate: true, paymentId: again?.id ?? null });
    }
    logError("Payment callback failed", { provider: id, error: error instanceof Error ? error.message : "unknown" });
    return apiError(500, "CALLBACK_FAILED", "Could not record the payment; please retry");
  }
}
