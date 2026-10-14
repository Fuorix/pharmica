import type { MasterPriceEntry } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { z } from "zod";
import { recordAudit, requireAuth } from "../../../../../../../src/auth/authorization";
import { nextScheduledPrice, PRICE_SOURCES, resolveCurrentPrice } from "../../../../../../../src/catalogue/master-price";
import { apiError } from "../../../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../../../src/lib/cors";
import { money, optionalTrimmed, parseBody } from "../../../../../../../src/lib/validation";

const priceSchema = z.object({
  price: money,
  source: z.enum(PRICE_SOURCES),
  reference: optionalTrimmed(),
  /** Defaults to now. A future date schedules the change; a past date records a back-dated price. */
  effectiveFrom: z.iso.datetime({ offset: true }).or(z.iso.date()).optional()
});

type Context = { params: Promise<{ id: string }> };

function toEntry(entry: { id: string; price: unknown; effectiveFrom: Date; source: string; reference: string | null; createdAt: Date }): MasterPriceEntry {
  return { id: entry.id, price: Number(entry.price), effectiveFrom: entry.effectiveFrom.toISOString(), source: entry.source, reference: entry.reference, createdAt: entry.createdAt.toISOString() };
}

async function history(masterProductId: string) {
  const entries = await db.masterPriceHistory.findMany({ where: { masterProductId }, orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] });
  return entries.map((entry) => ({ ...entry, price: Number(entry.price) }));
}

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** Full, append-only price history of a master product, with the price in force and any scheduled change. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const { id } = await context.params;
  if (!await db.masterProduct.findUnique({ where: { id } })) return withCors(apiError(404, "MASTER_PRODUCT_NOT_FOUND", "Master product was not found"), request);

  const entries = await history(id);
  const now = new Date();
  const current = resolveCurrentPrice(entries, now);
  const scheduled = nextScheduledPrice(entries, now);
  return withCors(Response.json({
    current: current ? toEntry(current) : null,
    scheduled: scheduled ? toEntry(scheduled) : null,
    history: entries.map(toEntry)
  }, { headers: { "x-api-version": "v1" } }), request);
}

/** Records a new official price. History is never overwritten; the stored current price follows whichever entry is in force. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const access = await requireAuth(request, ["super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const { id } = await context.params;
  const parsed = await parseBody(request, priceSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const body = parsed.data;

  const master = await db.masterProduct.findUnique({ where: { id } });
  if (!master) return withCors(apiError(404, "MASTER_PRODUCT_NOT_FOUND", "Master product was not found"), request);

  const now = new Date();
  const entry = await db.$transaction(async (transaction) => {
    const created = await transaction.masterPriceHistory.create({
      data: { masterProductId: id, price: body.price, effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : now, source: body.source, reference: body.reference, recordedById: access.user.id }
    });
    const entries = (await transaction.masterPriceHistory.findMany({ where: { masterProductId: id } })).map((row) => ({ ...row, price: Number(row.price) }));
    const current = resolveCurrentPrice(entries, now);
    // A scheduled price leaves the current one alone until it starts, even for a medicine with no earlier history.
    if (current) await transaction.masterProduct.update({ where: { id }, data: { officialRetailPrice: current.price } });
    return created;
  });

  await recordAudit({ userId: access.user.id, action: "catalogue.master_price_recorded", entityType: "master_product", entityId: id, metadata: { price: body.price, source: body.source, reference: body.reference, effectiveFrom: entry.effectiveFrom.toISOString() } });
  return withCors(Response.json({ entry: toEntry(entry) }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}
