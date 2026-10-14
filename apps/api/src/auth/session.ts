import { createHash, randomBytes } from "node:crypto";
import type { AuthUser, UserRole } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";

export const SESSION_COOKIE = "pharmica_session";
const DAY_MS = 24 * 60 * 60 * 1000;
// Web panels stay signed in for two weeks; a POS PIN session covers one working day.
const WEB_SESSION_MS = 14 * DAY_MS;
const DEVICE_SESSION_MS = 12 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const roleNames: Record<"OWNER" | "CASHIER" | "SUPER_ADMIN", UserRole> = {
  OWNER: "owner",
  CASHIER: "cashier",
  SUPER_ADMIN: "super-admin"
};

export function toRoleName(role: keyof typeof roleNames): UserRole {
  return roleNames[role];
}

export function toAuthUser(user: {
  id: string;
  name: string;
  login: string;
  role: keyof typeof roleNames;
  organisationId: string | null;
  branchId: string | null;
  mustChangeCredential?: boolean;
}, deviceId: string | null = null): AuthUser {
  return {
    id: user.id,
    name: user.name,
    login: user.login,
    role: roleNames[user.role],
    organisationId: user.organisationId,
    branchId: user.branchId,
    deviceId,
    ...(user.mustChangeCredential ? { mustChangeCredential: true } : {})
  };
}

export async function createSession(userId: string, deviceId?: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (deviceId ? DEVICE_SESSION_MS : WEB_SESSION_MS));

  await db.session.create({
    data: { userId, deviceId, tokenHash: hashToken(token), expiresAt }
  });

  return { token, expiresAt };
}

/**
 * Resolves a session token to its user. Rejects revoked, expired, and inactive-user sessions,
 * and sessions bound to a device that has since been deactivated. Active sessions slide forward
 * once less than half of their lifetime remains.
 */
export async function getSession(token: string | undefined): Promise<{ user: AuthUser; expiresAt: Date } | null> {
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { organisation: { select: { isActive: true } } } }, device: true }
  });

  const now = Date.now();
  if (!session || session.revokedAt || session.expiresAt.getTime() <= now || !session.user.isActive) return null;
  if (session.deviceId && !session.device?.isActive) return null;
  // Pharmica staff can suspend a whole pharmacy; its staff are signed out everywhere.
  if (session.user.organisation && !session.user.organisation.isActive) return null;

  const lifetime = session.deviceId ? DEVICE_SESSION_MS : WEB_SESSION_MS;
  let expiresAt = session.expiresAt;
  if (expiresAt.getTime() - now < lifetime / 2) {
    expiresAt = new Date(now + lifetime);
    await db.session.update({ where: { id: session.id }, data: { expiresAt } });
  }

  // A device session acts for the device's branch, even for an owner who spans branches.
  const user = toAuthUser(session.user, session.deviceId);
  if (session.device) user.branchId = session.device.branchId;
  return { user, expiresAt };
}

export async function getSessionUser(token: string | undefined): Promise<AuthUser | null> {
  return (await getSession(token))?.user ?? null;
}

export async function revokeSession(token: string | undefined): Promise<{ userId: string } | null> {
  if (!token) return null;
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!session || session.revokedAt) return null;
  await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  return { userId: session.userId };
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/**
 * Lax by default: the panels and the API share one site (localhost, or subdomains of one domain).
 * SESSION_COOKIE_SAMESITE=none lets a test deployment run the panels and the API on unrelated hosts (such as
 * separate *.up.railway.app addresses); browsers that block third-party cookies will not sign in there.
 */
function cookieAttributes(): string {
  if (process.env.SESSION_COOKIE_SAMESITE?.trim().toLowerCase() === "none") return "SameSite=None; Secure";
  return `SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function sessionCookie(token: string, expiresAt: Date): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; ${cookieAttributes()}; Expires=${expiresAt.toUTCString()}`;
}

export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; ${cookieAttributes()}; Max-Age=0`;
}
