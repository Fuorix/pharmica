import { db } from "@pharmica/database/client";
import { requireAuth, requireBranch } from "../../../../src/auth/authorization";
import { registerInclude, toRegisterEntry } from "../../../../src/accounts/accounts";
import { corsOptions, withCors } from "../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/**
 * The narcotics register for a branch, newest first: one entry per controlled-drug line sold, plus reversal
 * entries for voids and returns. `from` and `to` (YYYY-MM-DD) limit the dates. Entries are only ever created by
 * sales at the counter; there is no way to add, edit, or delete them by hand.
 */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const params = new URL(request.url).searchParams;
  const scope = await requireBranch(access.user, params.get("branchId"));
  if ("response" in scope) return withCors(scope.response, request);

  const from = params.get("from");
  const to = params.get("to");
  const records = await db.controlledDrugRecord.findMany({
    where: { branchId: scope.branch.id, createdAt: { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000) } : {}) } },
    include: registerInclude,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 1000
  });
  const batches = new Map((await db.batch.findMany({ where: { id: { in: records.map((record) => record.batchId).filter((id): id is string => !!id) } }, select: { id: true, batchNo: true } })).map((batch) => [batch.id, batch.batchNo]));
  return withCors(Response.json({ entries: records.map((record) => toRegisterEntry(record, record.batchId ? batches.get(record.batchId) ?? null : null)) }, { headers: { "x-api-version": "v1" } }), request);
}
