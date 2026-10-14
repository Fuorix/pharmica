import type { LoginRequest, AuthResponse } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { apiError } from "../../../../../src/lib/api-response";
import { logError } from "../../../../../src/lib/logger";
import { isLockedOut, recordAudit } from "../../../../../src/auth/authorization";
import { verifyCredential } from "../../../../../src/auth/credentials";
import { createSession, sessionCookie, toAuthUser } from "../../../../../src/auth/session";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response {
  return corsOptions(request);
}

export async function POST(request: Request): Promise<Response> {
  let body: LoginRequest;
  try {
    body = (await request.json()) as LoginRequest;
  } catch {
    return withCors(apiError(400, "INVALID_JSON", "Request body must be valid JSON"), request);
  }

  if (!body?.login || !body.credential) {
    return withCors(apiError(400, "INVALID_CREDENTIALS", "Login and credential are required"), request);
  }

  try {
    const login = body.login.toLowerCase().trim();
    const lockKey = `login:${login}`;
    if (await isLockedOut(lockKey)) {
      return withCors(apiError(429, "LOGIN_LOCKED", "Too many failed attempts. Try again in 15 minutes"), request);
    }

    const user = await db.user.findUnique({ where: { login } });
    const valid = user?.isActive && user.credentialHash ? await verifyCredential(body.credential, user.credentialHash) : false;

    if (!valid || !user) {
      await recordAudit({ organisationId: user?.organisationId ?? undefined, userId: user?.id, action: "auth.login_failed", entityType: "login", entityId: lockKey });
      return withCors(apiError(401, "AUTHENTICATION_FAILED", "Invalid login or credential"), request);
    }

    if (user.organisationId && !(await db.organisation.findUnique({ where: { id: user.organisationId }, select: { isActive: true } }))?.isActive) {
      return withCors(apiError(403, "ORGANISATION_SUSPENDED", "This pharmacy is suspended. Contact Pharmica support."), request);
    }

    const session = await createSession(user.id);
    await recordAudit({ organisationId: user.organisationId ?? undefined, branchId: user.branchId ?? undefined, userId: user.id, action: "auth.login", entityType: "user", entityId: user.id, metadata: { method: "password" } });
    const responseBody: AuthResponse = { user: toAuthUser(user), expiresAt: session.expiresAt.toISOString() };

    const response = Response.json(responseBody, { headers: { "x-api-version": "v1" } });
    response.headers.append("Set-Cookie", sessionCookie(session.token, session.expiresAt));
    return withCors(response, request);
  } catch (error) {
    logError("Authentication request failed", { error: error instanceof Error ? error.message : "unknown" });
    return withCors(apiError(500, "AUTHENTICATION_UNAVAILABLE", "Authentication is temporarily unavailable"), request);
  }
}
