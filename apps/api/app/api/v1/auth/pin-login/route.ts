import type { AuthResponse, PinLoginRequest } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { authenticateDevice, isLockedOut, recordAudit } from "../../../../../src/auth/authorization";
import { verifyCredential } from "../../../../../src/auth/credentials";
import { createSession, sessionCookie, toAuthUser } from "../../../../../src/auth/session";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** POS sign-in: an activated device plus the user's PIN opens a session bound to that device. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as PinLoginRequest | null;
  if (!body?.userId || !body.pin) return withCors(apiError(400, "INVALID_CREDENTIALS", "User and PIN are required"), request);

  const device = await authenticateDevice(request);
  if (!device) return withCors(apiError(401, "DEVICE_NOT_LINKED", "This counter is not linked or has been turned off"), request);
  if (!device.branch.organisation.isActive) return withCors(apiError(403, "ORGANISATION_SUSPENDED", "This pharmacy is suspended. Contact Pharmica support."), request);

  const lockKey = `pin:${body.userId}`;
  if (await isLockedOut(lockKey)) return withCors(apiError(429, "LOGIN_LOCKED", "Too many failed attempts. Try again in 15 minutes"), request);

  const user = await db.user.findUnique({ where: { id: body.userId } });
  const eligible = user?.isActive
    && user.role !== "SUPER_ADMIN"
    && user.organisationId === device.branch.organisationId
    && (!user.branchId || user.branchId === device.branchId);
  const valid = eligible && user.pinHash ? await verifyCredential(body.pin, user.pinHash) : false;

  if (!valid || !user) {
    await recordAudit({ organisationId: device.branch.organisationId, branchId: device.branchId, userId: eligible ? user?.id : undefined, action: "auth.login_failed", entityType: "login", entityId: lockKey, metadata: { method: "pin", deviceId: device.id } });
    return withCors(apiError(401, "AUTHENTICATION_FAILED", "Invalid PIN"), request);
  }

  const session = await createSession(user.id, device.id);
  await db.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  await recordAudit({ organisationId: device.branch.organisationId, branchId: device.branchId, userId: user.id, action: "auth.login", entityType: "user", entityId: user.id, metadata: { method: "pin", deviceId: device.id } });

  const authUser = { ...toAuthUser(user, device.id), branchId: device.branchId };
  const responseBody: AuthResponse = { user: authUser, expiresAt: session.expiresAt.toISOString(), token: session.token };
  const response = Response.json(responseBody, { headers: { "x-api-version": "v1" } });
  response.headers.append("Set-Cookie", sessionCookie(session.token, session.expiresAt));
  return withCors(response, request);
}
