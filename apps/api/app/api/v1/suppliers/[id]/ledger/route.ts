import { db } from "@pharmica/database/client";
import { ledgerBalance } from "@pharmica/domain";
import { canAccessScope, recordAudit, requireAuth } from "../../../../../../src/auth/authorization";
import { apiError } from "../../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const { id } = await context.params;
  const supplier = await db.supplier.findUnique({ where: { id }, include: { branch: true } });
  if (!supplier || !canAccessScope(access.user, supplier.branch.organisationId, supplier.branchId)) return withCors(apiError(403, "FORBIDDEN", "Supplier access denied"), request);
  const entries = await db.supplierLedgerEntry.findMany({ where: { supplierId: id }, orderBy: { createdAt: "desc" } });
  const balance = ledgerBalance(entries);
  return withCors(Response.json({ supplier, entries, balance }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { amount?: number; type?: "PAYMENT" | "ADJUSTMENT"; note?: string } | null;
  if (!body?.type || typeof body.amount !== "number" || body.amount <= 0) return withCors(apiError(400, "INVALID_LEDGER_ENTRY", "Positive amount and entry type are required"), request);
  const supplier = await db.supplier.findUnique({ where: { id }, include: { branch: true } });
  if (!supplier || !canAccessScope(access.user, supplier.branch.organisationId, supplier.branchId)) return withCors(apiError(403, "FORBIDDEN", "Supplier access denied"), request);
  const entry = await db.supplierLedgerEntry.create({ data: { branchId: supplier.branchId, supplierId: supplier.id, userId: access.user.id, type: body.type, amount: body.amount, note: body.note?.trim() } });
  await recordAudit({ organisationId: supplier.branch.organisationId, branchId: supplier.branchId, userId: access.user.id, action: `supplier.${body.type.toLowerCase()}`, entityType: "supplier_ledger", entityId: entry.id });
  return withCors(Response.json({ entry }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}
