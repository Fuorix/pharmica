import type { AuthUser } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { z } from "zod";
import { requireAuth } from "../../../../../src/auth/authorization";
import { commitImport, ImportCommitError } from "../../../../../src/imports/commit";
import { IMPORT_FIELDS } from "../../../../../src/imports/fields";
import { applyMapping, decide, jobDetail, jobForUser, requireImportAllowed } from "../../../../../src/imports/jobs";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";
import { parseBody } from "../../../../../src/lib/validation";

type Context = { params: Promise<{ id: string }> };

const patchSchema = z.union([
  z.object({ columnMap: z.record(z.string(), z.string()) }),
  z.object({ decisions: z.array(z.object({ rowId: z.string().min(1), action: z.enum(["MASTER", "EXISTING", "NEW", "SKIP", "CREATE"]), masterProductId: z.string().optional(), productId: z.string().optional() })).min(1).max(500) })
]);
const actionSchema = z.object({ action: z.enum(["commit", "cancel"]) });

export function OPTIONS(request: Request): Response { return corsOptions(request); }

type Loaded = { response: Response } | { user: AuthUser; job: Prisma.ImportJobGetPayload<object> };

async function load(request: Request, context: Context): Promise<Loaded> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return { response: withCors(access.response, request) };
  const job = await jobForUser(access.user, (await context.params).id);
  if (job instanceof Response) return { response: withCors(job, request) };
  return { user: access.user, job };
}

const ok = (request: Request, body: unknown) => withCors(Response.json(body, { headers: { "x-api-version": "v1" } }), request);

/** The import with its rows; `filter` is all, attention, review, ready, invalid, skipped, or committed. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const loaded = await load(request, context);
  if ("response" in loaded) return loaded.response;
  const params = new URL(request.url).searchParams;
  return ok(request, await jobDetail(loaded.job, { filter: params.get("filter") ?? "all", offset: Number(params.get("offset") ?? 0) || 0, limit: Number(params.get("limit") ?? 200) || 200 }));
}

/** Change the column matching (all rows are checked again), or record decisions on rows. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const loaded = await load(request, context);
  if ("response" in loaded) return loaded.response;
  const { job, user } = loaded;
  if (job.status === "COMMITTED" || job.status === "CANCELLED") return withCors(apiError(409, "IMPORT_CLOSED", `This import is ${job.status.toLowerCase()}`), request);
  const blocked = await requireImportAllowed(user, job.organisationId);
  if (blocked) return withCors(blocked, request);
  const body = await parseBody(request, patchSchema);
  if ("response" in body) return withCors(body.response, request);

  if ("columnMap" in body.data) {
    const columnMap = Object.fromEntries(Object.entries(body.data.columnMap).filter(([, header]) => header));
    const unknown = Object.entries(columnMap).find(([key, header]) => !IMPORT_FIELDS[job.kind].some((field) => field.key === key) || !job.headers.includes(header));
    if (unknown) return withCors(apiError(400, "INVALID_MAPPING", `"${unknown[1]}" is not a column of this file, or "${unknown[0]}" is not a field`), request);
    const missing = IMPORT_FIELDS[job.kind].find((field) => field.required && !columnMap[field.key]);
    if (missing) return withCors(apiError(400, "INVALID_MAPPING", `Choose the column for ${missing.label}`), request);
    return ok(request, await jobDetail(await applyMapping(job, columnMap, user), { filter: "all" }));
  }
  if (job.status !== "REVIEW") return withCors(apiError(409, "MAPPING_NEEDED", "Match the columns first"), request);
  const result = await decide(job, body.data.decisions, user);
  return ok(request, { ...result, ...(await jobDetail((await db.importJob.findUniqueOrThrow({ where: { id: job.id } })), { filter: "all" })) });
}

/** Commit (all or nothing) or cancel the import. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const loaded = await load(request, context);
  if ("response" in loaded) return loaded.response;
  const { job, user } = loaded;
  const blocked = await requireImportAllowed(user, job.organisationId);
  if (blocked) return withCors(blocked, request);
  const body = await parseBody(request, actionSchema);
  if ("response" in body) return withCors(body.response, request);

  if (body.data.action === "cancel") {
    if (job.status === "COMMITTED") return withCors(apiError(409, "IMPORT_CLOSED", "A committed import cannot be cancelled"), request);
    await db.importJob.update({ where: { id: job.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await db.auditLog.create({ data: { organisationId: job.organisationId, branchId: job.branchId, userId: user.id, action: "import.cancelled", entityType: "import", entityId: job.id } });
    return ok(request, await jobDetail(await db.importJob.findUniqueOrThrow({ where: { id: job.id } })));
  }
  try {
    await commitImport(job.id, user.id);
  } catch (error) {
    const message = error instanceof ImportCommitError ? error.message : "The import failed and nothing was changed. Try again, or contact support.";
    // The transaction rolled back: record why, so the next person to open the import sees it.
    await db.importJob.update({ where: { id: job.id }, data: { lastError: message } }).catch(() => undefined);
    await db.auditLog.create({ data: { organisationId: job.organisationId, branchId: job.branchId, userId: user.id, action: "import.commit_failed", entityType: "import", entityId: job.id, metadata: { message, detail: error instanceof Error ? error.message : null } } });
    return withCors(apiError(error instanceof ImportCommitError ? 409 : 500, "IMPORT_NOT_COMMITTED", message), request);
  }
  return ok(request, await jobDetail(await db.importJob.findUniqueOrThrow({ where: { id: job.id } }), { filter: "all" }));
}
