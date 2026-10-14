import type { ReceivePurchaseResponse } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { z } from "zod";
import { requireAuth, requireBranch } from "../../../../src/auth/authorization";
import { purchaseInclude, receivePurchase, StockError, toPurchaseSummary } from "../../../../src/inventory/stock";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";
import { money, parseBody } from "../../../../src/lib/validation";

const lineSchema = z.object({
  productId: z.string().min(1).optional(),
  masterProductId: z.string().min(1).optional(),
  batchNo: z.string().trim().min(1).max(40),
  expiryDate: z.iso.date(),
  quantity: z.number().int().nonnegative(),
  bonusQuantity: z.number().int().nonnegative().default(0),
  costPrice: money,
  discount: money.default(0),
  retailPrice: money,
  serialNumber: z.string().trim().max(40).optional()
}).refine((line) => line.productId || line.masterProductId, "Each line needs a product");

const purchaseSchema = z.object({
  branchId: z.string().min(1),
  supplier: z.object({ id: z.string().min(1).optional(), name: z.string().trim().min(1).max(120), phone: z.string().trim().max(30).optional() }),
  invoiceNumber: z.string().trim().max(60).optional(),
  invoiceDate: z.iso.date().optional(),
  invoiceDiscount: money.default(0),
  lines: z.array(lineSchema).min(1).max(300)
});

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** Recent purchases with their lines, bonus packs, and discounts. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const scope = await requireBranch(access.user, new URL(request.url).searchParams.get("branchId"));
  if ("response" in scope) return withCors(scope.response, request);
  const purchases = await db.purchase.findMany({ where: { branchId: scope.branch.id }, include: purchaseInclude, orderBy: { receivedAt: "desc" }, take: 100 });
  return withCors(Response.json({ purchases: purchases.map(toPurchaseSummary) }, { headers: { "x-api-version": "v1" } }), request);
}

/** Receives a supplier invoice from the owner panel. Counters receive through the offline outbox instead. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const parsed = await parseBody(request, purchaseSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const { branchId, ...input } = parsed.data;
  const scope = await requireBranch(access.user, branchId);
  if ("response" in scope) return withCors(scope.response, request);

  try {
    const result = await db.$transaction((tx) => receivePurchase(tx, { branchId: scope.branch.id, organisationId: scope.branch.organisationId, userId: access.user.id }, input));
    const purchase = await db.purchase.findUniqueOrThrow({ where: { id: result.purchaseId }, include: purchaseInclude });
    const body: ReceivePurchaseResponse = { purchase: toPurchaseSummary(purchase), warnings: result.warnings };
    return withCors(Response.json(body, { status: 201, headers: { "x-api-version": "v1" } }), request);
  } catch (error) {
    if (error instanceof StockError) return withCors(apiError(400, error.code, error.message), request);
    throw error;
  }
}
