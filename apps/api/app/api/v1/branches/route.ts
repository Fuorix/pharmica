import { db } from "@pharmica/database/client";
import { canAccessScope, requireAuth } from "../../../../src/auth/authorization";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** Branches the caller may work with: all of the organisation for owners, their own branch otherwise. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request);
  if ("response" in access) return withCors(access.response, request);

  const organisationId = new URL(request.url).searchParams.get("organisationId") ?? access.user.organisationId;
  if (!organisationId || !canAccessScope(access.user, organisationId)) return withCors(apiError(403, "FORBIDDEN", "Organisation access denied"), request);

  const branches = await db.branch.findMany({
    where: { organisationId, ...(access.user.role !== "super-admin" && access.user.branchId ? { id: access.user.branchId } : {}) },
    select: { id: true, name: true },
    orderBy: { name: "asc" }
  });
  return withCors(Response.json({ branches }, { headers: { "x-api-version": "v1" } }), request);
}
