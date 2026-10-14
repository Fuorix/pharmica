import { canAccessScope, requireAuth } from "../../../../src/auth/authorization";
import { db } from "@pharmica/database/client";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const organisationId = new URL(request.url).searchParams.get("organisationId") ?? access.user.organisationId;
  if (!organisationId || !canAccessScope(access.user, organisationId)) return withCors(apiError(403, "FORBIDDEN", "Organisation access denied"), request);

  const logs = await db.auditLog.findMany({ where: { organisationId }, orderBy: { createdAt: "desc" }, take: 100 });
  return withCors(Response.json({ logs }, { headers: { "x-api-version": "v1" } }), request);
}
