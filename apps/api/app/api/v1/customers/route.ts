import { db } from "@pharmica/database/client";
import { ledgerBalance } from "@pharmica/domain";
import { canAccessScope, requireAuth } from "../../../../src/auth/authorization";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request);
  if ("response" in access) return withCors(access.response, request);
  const branchId = new URL(request.url).searchParams.get("branchId") ?? access.user.branchId;
  if (!branchId) return withCors(apiError(400, "BRANCH_REQUIRED", "A branch is required"), request);
  const branch = await db.branch.findUnique({ where: { id: branchId } });
  if (!branch || !canAccessScope(access.user, branch.organisationId, branch.id)) return withCors(apiError(403, "FORBIDDEN", "Branch access denied"), request);
  const customers = await db.customer.findMany({ where: { branchId }, include: { ledger: { select: { type: true, amount: true } } }, orderBy: { name: "asc" } });
  return withCors(Response.json({ customers: customers.map(({ ledger, ...customer }) => ({ ...customer, creditLimit: Number(customer.creditLimit), balance: ledgerBalance(ledger) })) }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "cashier", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { branchId?: string; name?: string; phone?: string; creditLimit?: number } | null;
  if (!body?.branchId || !body.name) return withCors(apiError(400, "INVALID_CUSTOMER", "Branch and customer name are required"), request);
  const branch = await db.branch.findUnique({ where: { id: body.branchId } });
  if (!branch || !canAccessScope(access.user, branch.organisationId, branch.id)) return withCors(apiError(403, "FORBIDDEN", "Branch access denied"), request);
  const customer = await db.customer.create({ data: { branchId: branch.id, name: body.name.trim(), phone: body.phone?.trim(), creditLimit: body.creditLimit ?? 0 } });
  return withCors(Response.json({ customer }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}
