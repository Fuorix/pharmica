import { db } from "@pharmica/database/client";
import { z } from "zod";
import { recordAudit, requireAuth } from "../../../../../src/auth/authorization";
import { masterSearchWhere, rankMatches, toMasterSummary } from "../../../../../src/catalogue/catalogue";
import { PRICE_SOURCES } from "../../../../../src/catalogue/master-price";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";
import { money, optionalTrimmed, parseBody, trimmed } from "../../../../../src/lib/validation";

const createSchema = z.object({
  name: trimmed(),
  brand: optionalTrimmed(),
  generic: optionalTrimmed(),
  company: optionalTrimmed(),
  dosageForm: optionalTrimmed(60),
  strength: optionalTrimmed(60),
  drapRegistrationNo: optionalTrimmed(40),
  barcode: optionalTrimmed(64),
  unitsPerPack: z.number().int().min(1).max(1000).default(1),
  tabletsPerStrip: z.number().int().min(1).max(1000).default(1),
  officialRetailPrice: money.optional(),
  isPrescriptionOnly: z.boolean().default(false),
  isControlled: z.boolean().default(false),
  priceSource: z.enum(PRICE_SOURCES).default("MANUAL"),
  priceReference: optionalTrimmed()
});

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const query = new URL(request.url).searchParams.get("q")?.trim();
  const products = await db.masterProduct.findMany({ where: query ? masterSearchWhere(query) : undefined, orderBy: { name: "asc" }, take: 100 });
  const summaries = products.map(toMasterSummary);
  return withCors(Response.json({ products: query ? rankMatches(summaries, query) : summaries }, { headers: { "x-api-version": "v1" } }), request);
}

/** Pharmica admins add a medicine to the master list; its starting price becomes the first history entry. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const parsed = await parseBody(request, createSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const { priceSource, priceReference, ...fields } = parsed.data;

  const duplicate = await db.masterProduct.findFirst({
    where: { OR: [...(fields.barcode ? [{ barcode: fields.barcode }] : []), ...(fields.drapRegistrationNo ? [{ drapRegistrationNo: fields.drapRegistrationNo }] : [])] }
  });
  if ((fields.barcode || fields.drapRegistrationNo) && duplicate) return withCors(apiError(409, "MASTER_PRODUCT_EXISTS", `${duplicate.name} already uses that barcode or registration number`), request);

  const product = await db.$transaction(async (transaction) => {
    const created = await transaction.masterProduct.create({ data: { ...fields, source: priceSource } });
    if (fields.officialRetailPrice !== undefined) {
      await transaction.masterPriceHistory.create({ data: { masterProductId: created.id, price: fields.officialRetailPrice, effectiveFrom: new Date(), source: priceSource, reference: priceReference, recordedById: access.user.id } });
    }
    return created;
  });
  await recordAudit({ userId: access.user.id, action: "catalogue.master_product_created", entityType: "master_product", entityId: product.id });
  return withCors(Response.json({ product: toMasterSummary(product) }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}
