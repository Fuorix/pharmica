import { db } from "@pharmica/database/client";
import { z } from "zod";
import { duplicateCandidates, mergeMasterProducts } from "../../../../../../src/admin/catalogue";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../../src/admin/http";
import { apiError } from "../../../../../../src/lib/api-response";
import { parseBody, trimmed } from "../../../../../../src/lib/validation";

const mergeSchema = z.object({ keepId: z.string().min(1), mergeId: z.string().min(1), reason: trimmed(300) });

export const OPTIONS = OPTIONS_HANDLER;

/** Master entries that look like the same medicine, and the merges already done. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const merges = await db.masterProductMerge.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  const names = new Map((await db.masterProduct.findMany({ where: { id: { in: merges.map((merge) => merge.keptId) } }, select: { id: true, name: true } })).map((master) => [master.id, master.name]));
  return json(request, {
    candidates: await duplicateCandidates(),
    merges: merges.map((merge) => ({ id: merge.id, keptId: merge.keptId, keptName: names.get(merge.keptId) ?? null, mergedId: merge.mergedId, mergedName: merge.mergedName, reason: merge.reason, relinked: merge.branchProductsRelinked, unlinked: merge.branchProductsUnlinked, createdAt: merge.createdAt.toISOString() }))
  });
}

/** Merges a duplicate into the entry kept. Recorded with who, why, and what moved. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const body = await parseBody(request, mergeSchema);
  if ("response" in body) return withCors(body.response, request);
  const result = await mergeMasterProducts({ ...body.data, actorId: access.user.id });
  if ("error" in result) return withCors(apiError(400, "MERGE_REFUSED", result.error ?? "These products cannot be merged"), request);
  return json(request, { relinked: result.relinked, unlinked: result.unlinked });
}
