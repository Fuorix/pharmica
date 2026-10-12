import { z } from "zod";
import { createPriceListUpload, uploadSummaries } from "../../../../../../src/admin/catalogue";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../../src/admin/http";
import { PRICE_SOURCES } from "../../../../../../src/catalogue/master-price";
import { apiError } from "../../../../../../src/lib/api-response";
import { optionalTrimmed, parseBody, trimmed } from "../../../../../../src/lib/validation";

const uploadSchema = z.object({
  source: z.enum(PRICE_SOURCES.filter((source) => source !== "SHOP_REPORT" && source !== "DISTRIBUTOR_INVOICE") as ["SRO", "COMPANY_PRICE_LIST", "DRAP_IMPORT", "MANUAL"]),
  /** SRO number or price-list name, printed with every price it sets. */
  reference: trimmed(120),
  effectiveFrom: z.iso.date(),
  fileName: optionalTrimmed(200),
  /** The file contents as CSV text (up to about 5 MB). */
  csv: z.string().min(1).max(5_000_000)
});

export const OPTIONS = OPTIONS_HANDLER;

export async function GET(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const status = new URL(request.url).searchParams.get("status");
  return json(request, { uploads: await uploadSummaries(status === "REVIEW" || status === "PUBLISHED" || status === "REJECTED" ? { status } : {}) });
}

/** Uploads an SRO or price list. Rows are matched to the master list and wait for review; nothing is published yet. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const body = await parseBody(request, uploadSchema);
  if ("response" in body) return withCors(body.response, request);
  const created = await createPriceListUpload({ source: body.data.source, reference: body.data.reference, effectiveFrom: new Date(`${body.data.effectiveFrom}T00:00:00+05:00`), fileName: body.data.fileName ?? null, csv: body.data.csv, actorId: access.user.id });
  if ("error" in created) return withCors(apiError(400, "INVALID_PRICE_LIST", created.error ?? "The file could not be read"), request);
  const [summary] = await uploadSummaries({ id: created.upload.id });
  return json(request, { upload: summary }, 201);
}
