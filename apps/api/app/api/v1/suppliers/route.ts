import { db } from "@pharmica/database/client";
import { ledgerBalance } from "@pharmica/domain";
import { canAccessScope, requireAuth } from "../../../../src/auth/authorization";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const branchId = new URL(request.url).searchParams.get("branchId") ?? access.user.branchId;
  if (!branchId) return withCors(apiError(400, "BRANCH_REQUIRED", "A branch is required"), request);
  const branch = await db.branch.findUnique({ where: { id: branchId } });
  if (!branch || !canAccessScope(access.user, branch.organisationId, branch.id)) return withCors(apiError(403, "FORBIDDEN", "Branch access denied"), request);
  const suppliers = await db.supplier.findMany({ where: { branchId }, include: { ledger: { select: { type: true, amount: true } } }, orderBy: { name: "asc" } });
  return withCors(Response.json({ suppliers: suppliers.map(({ ledger, ...supplier }) => ({ ...supplier, balance: ledgerBalance(ledger) })) }, { headers: { "x-api-version": "v1" } }), request);
}
