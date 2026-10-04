import { db } from "@pharmica/database/client";
import { ledgerBalance } from "@pharmica/domain";
import { canAccessScope, recordAudit, requireAuth } from "../../../../../../src/auth/authorization";
import { apiError } from "../../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const access = await requireAuth(request);
  if ("response" in access) return withCors(access.response, request);
  const { id } = await context.params;
  const customer = await db.customer.findUnique({ where: { id }, include: { branch: true } });
  if (!customer || !canAccessScope(access.user, customer.branch.organisationId, customer.branchId)) return withCors(apiError(403, "FORBIDDEN", "Customer access denied"), request);
  const entries = await db.customerLedgerEntry.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" } });
  const balance = ledgerBalance(entries);
  return withCors(Response.json({ customer, entries, balance }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const access = await requireAuth(request, ["owner", "cashier", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { amount?: number; type?: "PAYMENT" | "ADJUSTMENT"; note?: string } | null;
  if (!body?.type || typeof body.amount !== "number" || body.amount <= 0) return withCors(apiError(400, "INVALID_LEDGER_ENTRY", "Positive amount and entry type are required"), request);
  const customer = await db.customer.findUnique({ where: { id }, include: { branch: true } });
  if (!customer || !canAccessScope(access.user, customer.branch.organisationId, customer.branchId)) return withCors(apiError(403, "FORBIDDEN", "Customer access denied"), request);
  const entry = await db.customerLedgerEntry.create({ data: { branchId: customer.branchId, customerId: customer.id, userId: access.user.id, type: body.type, amount: body.amount, note: body.note?.trim() } });
  await recordAudit({ organisationId: customer.branch.organisationId, branchId: customer.branchId, userId: access.user.id, action: `customer.${body.type.toLowerCase()}`, entityType: "customer_ledger", entityId: entry.id });
  return withCors(Response.json({ entry }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}
