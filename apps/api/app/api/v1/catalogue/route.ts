import type { CatalogueSearchResponse } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { z } from "zod";
import { recordAudit, requireAuth, requireBranch } from "../../../../src/auth/authorization";
import { catalogueInclude, masterSearchWhere, productSearchWhere, rankMatches, toCatalogueProduct, toMasterSummary } from "../../../../src/catalogue/catalogue";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";
import { money, optionalTrimmed, parseBody, trimmed } from "../../../../src/lib/validation";

const categories = ["medicine", "cosmetic", "surgical", "baby", "general"] as const;

const addProductSchema = z.union([
  z.object({
    branchId: z.string().min(1),
    masterProductId: z.string().min(1),
    rackLocation: optionalTrimmed(40),
    lowStockThreshold: z.number().int().nonnegative().optional()
  }),
  z.object({
    branchId: z.string().min(1),
    name: trimmed(),
    category: z.enum(categories),
    company: optionalTrimmed(),
    generic: optionalTrimmed(),
    barcode: optionalTrimmed(64),
    unitsPerPack: z.number().int().min(1).max(1000).default(1),
    tabletsPerStrip: z.number().int().min(1).max(1000).default(1),
    retailPrice: money.optional(),
    rackLocation: optionalTrimmed(40),
    lowStockThreshold: z.number().int().nonnegative().optional()
  })
]);

const updateProductSchema = z.object({
  productId: z.string().min(1),
  rackLocation: z.string().trim().max(40).nullable().optional(),
  retailPriceOverride: money.nullable().optional(),
  lowStockThreshold: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional()
});

export function OPTIONS(request: Request): Response {
  return corsOptions(request);
}

/** Branch catalogue with live stock and selling prices. With `q`, also returns master-list medicines the branch does not stock yet. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request);
  if ("response" in access) return withCors(access.response, request);

  const params = new URL(request.url).searchParams;
  const scope = await requireBranch(access.user, params.get("branchId"));
  if ("response" in scope) return withCors(scope.response, request);
  const query = params.get("q")?.trim();
  const now = new Date();

  const products = await db.product.findMany({
    where: { branchId: scope.branch.id, isActive: true, ...(query ? productSearchWhere(query) : {}) },
    include: catalogueInclude,
    orderBy: { name: "asc" },
    take: query ? 50 : 500
  });
  const masterMatches = query
    ? await db.masterProduct.findMany({ where: { AND: [masterSearchWhere(query), { products: { none: { branchId: scope.branch.id } } }] }, orderBy: { name: "asc" }, take: 20 })
    : [];

  const body: CatalogueSearchResponse = {
    products: query ? rankMatches(products.map((product) => toCatalogueProduct(product, now)), query) : products.map((product) => toCatalogueProduct(product, now)),
    masterMatches: query ? rankMatches(masterMatches.map(toMasterSummary), query) : []
  };
  return withCors(Response.json(body, { headers: { "x-api-version": "v1" } }), request);
}

/** Adds a master-list medicine to the branch (idempotent), or creates a shop-specific item such as a cosmetic. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const parsed = await parseBody(request, addProductSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const body = parsed.data;

  const scope = await requireBranch(access.user, body.branchId);
  if ("response" in scope) return withCors(scope.response, request);
  const branch = scope.branch;

  let data: Prisma.ProductUncheckedCreateInput;
  if ("masterProductId" in body) {
    const master = await db.masterProduct.findUnique({ where: { id: body.masterProductId } });
    if (!master) return withCors(apiError(404, "MASTER_PRODUCT_NOT_FOUND", "Master product was not found"), request);
    const existing = await db.product.findUnique({ where: { branchId_masterProductId: { branchId: branch.id, masterProductId: master.id } }, include: catalogueInclude });
    if (existing) return withCors(Response.json({ product: toCatalogueProduct(existing) }, { headers: { "x-api-version": "v1" } }), request);
    data = { branchId: branch.id, masterProductId: master.id, name: master.name, generic: master.generic, barcode: master.barcode, rackLocation: body.rackLocation, lowStockThreshold: body.lowStockThreshold };
  } else {
    if (body.barcode && await db.product.findUnique({ where: { branchId_barcode: { branchId: branch.id, barcode: body.barcode } } })) {
      return withCors(apiError(409, "BARCODE_IN_USE", "Another item in this branch already uses that barcode"), request);
    }
    data = {
      branchId: branch.id,
      name: body.name,
      category: body.category.toUpperCase() as Prisma.ProductUncheckedCreateInput["category"],
      company: body.company,
      generic: body.generic,
      barcode: body.barcode,
      unitsPerPack: body.unitsPerPack,
      tabletsPerStrip: body.tabletsPerStrip,
      retailPriceOverride: body.retailPrice,
      rackLocation: body.rackLocation,
      lowStockThreshold: body.lowStockThreshold,
      isShopSpecific: true
    };
  }

  const product = await db.product.create({ data, include: catalogueInclude });
  await recordAudit({ organisationId: branch.organisationId, branchId: branch.id, userId: access.user.id, action: "catalogue.product_added", entityType: "product", entityId: product.id, metadata: { shopSpecific: product.isShopSpecific } });
  return withCors(Response.json({ product: toCatalogueProduct(product) }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}

/** Branch-level settings: rack location, shop price override, low-stock threshold, active flag. */
export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const parsed = await parseBody(request, updateProductSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const body = parsed.data;

  const existing = await db.product.findUnique({ where: { id: body.productId } });
  if (!existing) return withCors(apiError(404, "PRODUCT_NOT_FOUND", "Product was not found"), request);
  const scope = await requireBranch(access.user, existing.branchId);
  if ("response" in scope) return withCors(scope.response, request);

  const product = await db.product.update({
    where: { id: existing.id },
    data: {
      ...(body.rackLocation !== undefined ? { rackLocation: body.rackLocation || null } : {}),
      ...(body.retailPriceOverride !== undefined ? { retailPriceOverride: body.retailPriceOverride } : {}),
      ...(body.lowStockThreshold !== undefined ? { lowStockThreshold: body.lowStockThreshold } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {})
    },
    include: catalogueInclude
  });
  if (body.retailPriceOverride !== undefined) {
    await recordAudit({ organisationId: scope.branch.organisationId, branchId: existing.branchId, userId: access.user.id, action: "catalogue.price_override_changed", entityType: "product", entityId: existing.id, metadata: { from: existing.retailPriceOverride == null ? null : Number(existing.retailPriceOverride), to: body.retailPriceOverride } });
  }
  return withCors(Response.json({ product: toCatalogueProduct(product) }, { headers: { "x-api-version": "v1" } }), request);
}
