import { db } from "@pharmica/database/client";
import { z } from "zod";
import { requireAuth, requireBranch } from "../../../../src/auth/authorization";
import { adjustStock, inventoryReport, StockError } from "../../../../src/inventory/stock";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";
import { parseBody } from "../../../../src/lib/validation";

const adjustSchema = z.object({
  batchId: z.string().min(1),
  type: z.enum(["WRITE_OFF", "DAMAGE", "EXPIRY", "ADJUSTMENT"]),
  /** Base units; negative removes stock. */
  quantity: z.number().int().refine((value) => value !== 0, "Quantity cannot be zero"),
  reason: z.string().trim().min(1, "A reason is required").max(300)
});

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/**
 * Stock by product: sellable, near-expiry, and expired quantities, low-stock flag, and value at cost and retail.
 * `status=low|near-expiry|expired` filters; `nearExpiryDays` sets the warning window (default 90).
 */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request);
  if ("response" in access) return withCors(access.response, request);
  const params = new URL(request.url).searchParams;
  const scope = await requireBranch(access.user, params.get("branchId"));
  if ("response" in scope) return withCors(scope.response, request);

  const days = Number(params.get("nearExpiryDays") ?? 90);
  let items = await inventoryReport(scope.branch.id, { nearExpiryDays: Number.isInteger(days) && days > 0 && days <= 730 ? days : 90 });
  const status = params.get("status");
  if (status === "low") items = items.filter((item) => item.lowStock);
  if (status === "near-expiry") items = items.filter((item) => item.nearExpiry > 0);
  if (status === "expired") items = items.filter((item) => item.expired > 0);
  return withCors(Response.json({ items }, { headers: { "x-api-version": "v1" } }), request);
}

/** Write-off, damage, expiry, or a correction, always with a reason and an audit entry. */
export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const parsed = await parseBody(request, adjustSchema);
  if ("response" in parsed) return withCors(parsed.response, request);

  const batch = await db.batch.findUnique({ where: { id: parsed.data.batchId }, include: { product: true } });
  if (!batch) return withCors(apiError(404, "BATCH_NOT_FOUND", "Batch was not found"), request);
  const scope = await requireBranch(access.user, batch.product.branchId);
  if ("response" in scope) return withCors(scope.response, request);

  try {
    const result = await db.$transaction((tx) => adjustStock(tx, { branchId: scope.branch.id, organisationId: scope.branch.organisationId, userId: access.user.id }, parsed.data));
    const updated = await db.batch.findUniqueOrThrow({ where: { id: batch.id } });
    return withCors(Response.json({ batch: { id: updated.id, quantity: updated.quantity }, applied: result.applied, shortBy: result.shortBy }, { headers: { "x-api-version": "v1" } }), request);
  } catch (error) {
    if (error instanceof StockError) return withCors(apiError(400, error.code, error.message), request);
    throw error;
  }
}
