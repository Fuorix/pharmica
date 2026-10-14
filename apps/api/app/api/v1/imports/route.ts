import { db } from "@pharmica/database/client";
import { z } from "zod";
import { canAccessScope, requireAuth, requireBranch } from "../../../../src/auth/authorization";
import { createJob, jobDetail, requireImportAllowed, summaryOf } from "../../../../src/imports/jobs";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";
import { parseBody } from "../../../../src/lib/validation";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const uploadSchema = z.object({
  branchId: z.string().min(1),
  kind: z.enum(["STOCK", "CUSTOMERS", "SUPPLIERS"]),
  fileName: z.string().trim().min(1).max(200),
  /** The file, base64-encoded. */
  content: z.string().min(1).max(Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4)
});

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** Imports for the owner pharmacy (or, for Pharmica staff, the organisation named), newest first. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const params = new URL(request.url).searchParams;
  const organisationId = access.user.role === "super-admin" ? params.get("organisationId") : access.user.organisationId;
  if (!organisationId || !canAccessScope(access.user, organisationId)) return withCors(apiError(400, "ORGANISATION_REQUIRED", "Choose a pharmacy"), request);
  const jobs = await db.importJob.findMany({ where: { organisationId, ...(params.get("branchId") ? { branchId: params.get("branchId")! } : {}), ...(access.user.branchId ? { branchId: access.user.branchId } : {}) }, orderBy: { createdAt: "desc" }, take: 100 });
  return withCors(Response.json({ jobs: await Promise.all(jobs.map(summaryOf)) }, { headers: { "x-api-version": "v1" } }), request);
}

/** Uploads a file to import. It is read and checked, but nothing reaches the shop records until it is committed. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const body = await parseBody(request, uploadSchema);
  if ("response" in body) return withCors(body.response, request);
  const scope = await requireBranch(access.user, body.data.branchId);
  if ("response" in scope) return withCors(scope.response, request);
  const blocked = await requireImportAllowed(access.user, scope.branch.organisationId);
  if (blocked) return withCors(blocked, request);
  const content = Buffer.from(body.data.content, "base64");
  if (content.length > MAX_FILE_BYTES) return withCors(apiError(400, "FILE_TOO_LARGE", "Files up to 8 MB; split larger ones"), request);

  const created = await createJob({ user: access.user, organisationId: scope.branch.organisationId, branchId: scope.branch.id, kind: body.data.kind, fileName: body.data.fileName, content });
  if (created instanceof Response) return withCors(created, request);
  return withCors(Response.json({ ...(await jobDetail(created.job, { filter: "attention" })), resumed: created.resumed }, { status: created.resumed ? 200 : 201, headers: { "x-api-version": "v1" } }), request);
}
