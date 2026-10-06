import { db } from "@pharmica/database/client";
import { z } from "zod";
import { requireAuth, requireBranch } from "../../../../../../src/auth/authorization";
import { AccountError, adjustCustomer, recordCustomerPayment, toLedgerLines, toReceivable } from "../../../../../../src/accounts/accounts";
import { apiError } from "../../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../../src/lib/cors";
import { parseBody } from "../../../../../../src/lib/validation";

const entrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PAYMENT"), amount: z.number().finite().positive(), method: z.enum(["cash", "card"]).default("cash"), note: z.string().trim().max(200).optional() }),
  /** Positive adds to the debt, negative reduces it. Owners only, always with a reason. */
  z.object({ type: z.literal("ADJUSTMENT"), amount: z.number().finite().refine((value) => value !== 0, "Cannot be zero"), reason: z.string().trim().min(1, "A reason is required").max(300) })
]);

type Context = { params: Promise<{ id: string }> };

async function customerInScope(request: Request, context: Context, roles?: Parameters<typeof requireAuth>[1]) {
  const access = await requireAuth(request, roles);
  if ("response" in access) return access;
  const { id } = await context.params;
  const customer = await db.customer.findUnique({ where: { id } });
  if (!customer) return { response: apiError(404, "CUSTOMER_NOT_FOUND", "Customer was not found") };
  const scope = await requireBranch(access.user, customer.branchId);
  if ("response" in scope) return scope;
  return { user: access.user, customer, branch: scope.branch };
}

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** The customer's khata: every credit sale, payment, return, and adjustment, with the running balance and ageing. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const found = await customerInScope(request, context);
  if ("response" in found) return withCors(found.response, request);
  const entries = await db.customerLedgerEntry.findMany({ where: { customerId: found.customer.id }, include: { user: { select: { name: true } } } });
  return withCors(Response.json({ customer: toReceivable({ ...found.customer, ledger: entries }), entries: toLedgerLines(entries) }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const found = await customerInScope(request, context, ["owner", "cashier", "super-admin"]);
  if ("response" in found) return withCors(found.response, request);
  const parsed = await parseBody(request, entrySchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  if (parsed.data.type === "ADJUSTMENT" && found.user.role === "cashier") return withCors(apiError(403, "FORBIDDEN", "Only the owner can adjust a customer's balance"), request);

  const accountContext = { branchId: found.branch.id, organisationId: found.branch.organisationId, userId: found.user.id, deviceId: found.user.deviceId ?? undefined };
  try {
    const body = parsed.data;
    const entry = await db.$transaction((tx) => body.type === "PAYMENT"
      ? recordCustomerPayment(tx, accountContext, { customerId: found.customer.id, amount: body.amount, method: body.method, note: body.note })
      : adjustCustomer(tx, accountContext, { customerId: found.customer.id, amount: body.amount, reason: body.reason }));
    return withCors(Response.json({ entry: { id: entry.id, type: entry.type, amount: Number(entry.amount) } }, { status: 201, headers: { "x-api-version": "v1" } }), request);
  } catch (error) {
    if (error instanceof AccountError) return withCors(apiError(400, error.code, error.message), request);
    throw error;
  }
}
