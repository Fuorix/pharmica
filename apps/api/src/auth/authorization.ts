import { randomBytes, timingSafeEqual } from "node:crypto";
import { DEVICE_TOKEN_HEADER, type AuthUser, type UserRole } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { apiError } from "../lib/api-response";
import { SESSION_COOKIE, getSessionUser, hashToken } from "./session";

type Branch = Prisma.BranchGetPayload<object>;

export function getSessionToken(request: Request): string | undefined {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) return bearer;
  return request.headers.get("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
}

export async function requireAuth(
  request: Request,
  roles?: UserRole[],
  options: { device?: boolean; allowCredentialChange?: boolean } = {}
): Promise<{ user: AuthUser } | { response: Response }> {
  const user = await getSessionUser(getSessionToken(request));
  if (!user) return { response: apiError(401, "UNAUTHENTICATED", "A valid session is required") };
  // An account opened with a temporary password can do nothing else until the password is changed.
  if (user.mustChangeCredential && !options.allowCredentialChange) {
    return { response: apiError(403, "CREDENTIAL_CHANGE_REQUIRED", "Choose a new password before continuing") };
  }
  if (roles && !roles.includes(user.role)) {
    return { response: apiError(403, "FORBIDDEN", "You do not have permission for this action") };
  }
  if (options.device && !user.deviceId) {
    return { response: apiError(403, "DEVICE_SESSION_REQUIRED", "This action must be performed from an activated POS device") };
  }
  return { user };
}

export function canAccessScope(user: AuthUser, organisationId: string, branchId?: string): boolean {
  if (user.role === "super-admin") return true;
  if (user.organisationId !== organisationId) return false;
  return !branchId || !user.branchId || user.branchId === branchId;
}

/** Resolves the requested branch (or the user's own) and checks the user may act in it. */
export async function requireBranch(user: AuthUser, requestedBranchId: string | null | undefined): Promise<{ branch: Branch } | { response: Response }> {
  const branchId = requestedBranchId || user.branchId;
  if (!branchId) return { response: apiError(400, "BRANCH_REQUIRED", "A branch is required") };
  const branch = await db.branch.findUnique({ where: { id: branchId } });
  if (!branch || !canAccessScope(user, branch.organisationId, branch.id)) return { response: apiError(403, "FORBIDDEN", "Branch access denied") };
  return { branch };
}

export function newActivationCode(): string {
  return randomBytes(6).toString("hex").toUpperCase();
}

export function newDeviceSecret(): { secret: string; secretHash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, secretHash: hashToken(secret) };
}

/** Authenticates the POS device itself from the `x-device-token` header. */
export async function authenticateDevice(request: Request) {
  const [deviceId, secret] = request.headers.get(DEVICE_TOKEN_HEADER)?.split(".") ?? [];
  if (!deviceId || !secret) return null;
  const device = await db.device.findUnique({ where: { id: deviceId }, include: { branch: { include: { organisation: { select: { id: true, name: true, isActive: true } } } } } });
  if (!device?.isActive || !device.secretHash) return null;
  const expected = Buffer.from(device.secretHash, "hex");
  const actual = Buffer.from(hashToken(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? device : null;
}

const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/** True once a login key has failed too often within the lockout window. */
export async function isLockedOut(key: string): Promise<boolean> {
  const failures = await db.auditLog.count({
    where: { action: "auth.login_failed", entityId: key, createdAt: { gte: new Date(Date.now() - LOCKOUT_WINDOW_MS) } }
  });
  return failures >= LOCKOUT_ATTEMPTS;
}

export async function recordAudit(input: {
  organisationId?: string;
  branchId?: string;
  userId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.auditLog.create({
    data: {
      organisationId: input.organisationId,
      branchId: input.branchId,
      userId: input.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata as Prisma.InputJsonValue | undefined
    }
  });
}
