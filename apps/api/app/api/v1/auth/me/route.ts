import type { AuthResponse } from "@pharmica/contracts";
import { getSessionToken } from "../../../../../src/auth/authorization";
import { getSession } from "../../../../../src/auth/session";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response {
  return corsOptions(request);
}

export async function GET(request: Request): Promise<Response> {
  const session = await getSession(getSessionToken(request));
  if (!session) return withCors(apiError(401, "UNAUTHENTICATED", "A valid session is required"), request);

  const response: AuthResponse = { user: session.user, expiresAt: session.expiresAt.toISOString() };
  return withCors(Response.json(response, { headers: { "x-api-version": "v1" } }), request);
}
