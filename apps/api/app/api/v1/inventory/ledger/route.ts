import { db } from "@pharmica/database/client";
import { requireAuth, requireBranch } from "../../../../../src/auth/authorization";
import { ledgerMismatches } from "../../../../../src/inventory/stock";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/**
 * The stock ledger. With `productId`: every movement of that product, newest first, with a running balance per
 * batch. Without: a consistency check listing any batch whose stock differs from its ledger (normally none).
 */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const params = new URL(request.url).searchParams;
  const productId = params.get("productId");

  if (!productId) {
    const scope = await requireBranch(access.user, params.get("branchId"));
    if ("response" in scope) return withCors(scope.response, request);
    return withCors(Response.json({ mismatches: await ledgerMismatches(scope.branch.id) }, { headers: { "x-api-version": "v1" } }), request);
  }

  const product = await db.product.findUnique({ where: { id: productId } });
  if (!product) return withCors(apiError(404, "PRODUCT_NOT_FOUND", "Product was not found"), request);
  const scope = await requireBranch(access.user, product.branchId);
  if ("response" in scope) return withCors(scope.response, request);

  const movements = await db.stockMovement.findMany({ where: { productId }, include: { batch: true, user: { select: { name: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const balances = new Map<string, number>();
  const rows = movements.map((movement) => {
    const key = movement.batchId ?? "none";
    const balance = (balances.get(key) ?? 0) + movement.quantity;
    balances.set(key, balance);
    return { id: movement.id, at: movement.createdAt.toISOString(), type: movement.type, quantity: movement.quantity, batchNo: movement.batch?.batchNo ?? null, batchBalance: balance, reason: movement.reason, by: movement.user?.name ?? "System", referenceId: movement.referenceId };
  });
  return withCors(Response.json({ movements: rows.reverse() }, { headers: { "x-api-version": "v1" } }), request);
}
