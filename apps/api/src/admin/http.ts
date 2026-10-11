import type { AuthUser } from "@pharmica/contracts";
import { requireAuth } from "../auth/authorization";
import { withCors } from "../lib/cors";

/**
 * Every /admin route is for Pharmica staff only. Owners and cashiers get 403 however they call it, so super-admin
 * powers never leak into a tenant role.
 */
export async function requireAdmin(request: Request): Promise<{ user: AuthUser } | { response: Response }> {
  const access = await requireAuth(request, ["super-admin"]);
  if ("response" in access) return { response: withCors(access.response, request) };
  return access;
}

export function json(request: Request, body: unknown, status = 200): Response {
  return withCors(Response.json(body, { status, headers: { "x-api-version": "v1" } }), request);
}

export { corsOptions as OPTIONS_HANDLER, withCors } from "../lib/cors";
