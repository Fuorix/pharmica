import { db } from "@pharmica/database/client";
import { canAccessScope, recordAudit, requireAuth } from "../../../../src/auth/authorization";
import { hashCredential } from "../../../../src/auth/credentials";
import { revokeUserSessions, toRoleName } from "../../../../src/auth/session";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";

const roleMap = { owner: "OWNER", cashier: "CASHIER", "super-admin": "SUPER_ADMIN" } as const;
type RoleName = keyof typeof roleMap;
const PIN_PATTERN = /^\d{4,6}$/;
const MIN_CREDENTIAL_LENGTH = 8;

const userFields = { id: true, organisationId: true, name: true, login: true, role: true, branchId: true, isActive: true, createdAt: true, pinHash: true, maxDiscountPercent: true } as const;
function toUserSummary({ pinHash, role, maxDiscountPercent, ...user }: { pinHash: string | null; role: "OWNER" | "CASHIER" | "SUPER_ADMIN"; maxDiscountPercent: number; [key: string]: unknown }) {
  // Owners can always give any discount.
  return { ...user, role: toRoleName(role), hasPin: pinHash != null, maxDiscountPercent: role === "CASHIER" ? maxDiscountPercent : null };
}

function validateSecrets(body: { credential?: string; pin?: string; maxDiscountPercent?: unknown }): Response | null {
  if (body.maxDiscountPercent !== undefined && (!Number.isInteger(body.maxDiscountPercent) || (body.maxDiscountPercent as number) < 0 || (body.maxDiscountPercent as number) > 100)) return apiError(400, "INVALID_DISCOUNT_LIMIT", "Discount limit must be a whole percent from 0 to 100");
  if (body.pin !== undefined && !PIN_PATTERN.test(body.pin)) return apiError(400, "INVALID_PIN", "PIN must be 4 to 6 digits");
  if (body.credential !== undefined && body.credential.length < MIN_CREDENTIAL_LENGTH) return apiError(400, "WEAK_CREDENTIAL", `Password must be at least ${MIN_CREDENTIAL_LENGTH} characters`);
  return null;
}

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);

  const organisationId = new URL(request.url).searchParams.get("organisationId") ?? access.user.organisationId;
  if (!organisationId || !canAccessScope(access.user, organisationId)) return withCors(apiError(403, "FORBIDDEN", "Organisation access denied"), request);

  const users = await db.user.findMany({ where: { organisationId }, select: userFields, orderBy: { createdAt: "asc" } });
  return withCors(Response.json({ users: users.map(toUserSummary) }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);

  const body = await request.json().catch(() => null) as {
    organisationId?: string;
    branchId?: string;
    name?: string;
    login?: string;
    credential?: string;
    pin?: string;
    role?: RoleName;
    maxDiscountPercent?: number;
  } | null;
  if (!body?.name?.trim() || !body.login?.trim() || !body.role || !Object.hasOwn(roleMap, body.role)) return withCors(apiError(400, "INVALID_USER", "Name, login, and a valid role are required"), request);
  const invalid = validateSecrets(body);
  if (invalid) return withCors(invalid, request);
  if (body.role === "cashier" && (!body.branchId || !body.pin)) return withCors(apiError(400, "INVALID_USER", "Cashiers need a branch and a PIN"), request);
  if (body.role !== "cashier" && !body.credential) return withCors(apiError(400, "INVALID_USER", "Owners and admins need a password"), request);

  if (body.role === "super-admin") {
    if (access.user.role !== "super-admin") return withCors(apiError(403, "FORBIDDEN", "Only Pharmica admins can create admin users"), request);
  }
  const organisationId = body.role === "super-admin" ? null : access.user.role === "super-admin" ? body.organisationId : access.user.organisationId;
  if (body.role !== "super-admin" && (!organisationId || !canAccessScope(access.user, organisationId, body.branchId))) return withCors(apiError(403, "FORBIDDEN", "Organisation or branch access denied"), request);

  if (body.branchId) {
    const branch = await db.branch.findFirst({ where: { id: body.branchId, organisationId: organisationId ?? undefined } });
    if (!branch) return withCors(apiError(400, "INVALID_BRANCH", "Branch does not belong to the organisation"), request);
  }

  const login = body.login.trim().toLowerCase();
  if (await db.user.findUnique({ where: { login } })) return withCors(apiError(409, "USER_ALREADY_EXISTS", "A user with that login already exists"), request);

  const user = await db.user.create({
    data: {
      organisationId,
      branchId: body.role === "super-admin" ? null : body.branchId,
      name: body.name.trim(),
      login,
      credentialHash: body.credential ? await hashCredential(body.credential) : null,
      pinHash: body.pin ? await hashCredential(body.pin) : null,
      maxDiscountPercent: body.maxDiscountPercent ?? 0,
      role: roleMap[body.role]
    },
    select: userFields
  });
  await recordAudit({ organisationId: organisationId ?? undefined, branchId: user.branchId ?? undefined, userId: access.user.id, action: "user.created", entityType: "user", entityId: user.id, metadata: { role: body.role } });
  return withCors(Response.json({ user: toUserSummary(user) }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}

export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);

  const body = await request.json().catch(() => null) as {
    userId?: string;
    name?: string;
    role?: RoleName;
    branchId?: string | null;
    isActive?: boolean;
    credential?: string;
    pin?: string;
    maxDiscountPercent?: number;
  } | null;
  if (!body?.userId) return withCors(apiError(400, "INVALID_USER", "User ID is required"), request);
  if (body.role !== undefined && !Object.hasOwn(roleMap, body.role)) return withCors(apiError(400, "INVALID_ROLE", "Unsupported role"), request);
  const invalid = validateSecrets(body);
  if (invalid) return withCors(invalid, request);

  const target = await db.user.findUnique({ where: { id: body.userId } });
  if (!target) return withCors(apiError(404, "USER_NOT_FOUND", "User was not found"), request);
  const isAdminTarget = target.role === "SUPER_ADMIN";
  if (access.user.role !== "super-admin") {
    if (isAdminTarget || body.role === "super-admin") return withCors(apiError(403, "FORBIDDEN", "Owners cannot manage Pharmica admin users"), request);
    if (!target.organisationId || !canAccessScope(access.user, target.organisationId, target.branchId ?? undefined)) return withCors(apiError(403, "FORBIDDEN", "User access denied"), request);
  }
  if (target.id === access.user.id && (body.isActive === false || (body.role && body.role !== access.user.role))) {
    return withCors(apiError(409, "CANNOT_CHANGE_SELF", "You cannot deactivate yourself or change your own role"), request);
  }

  const nextRole = body.role ? roleMap[body.role] : target.role;
  const nextBranchId = body.branchId === undefined ? target.branchId : body.branchId;
  if (nextBranchId && nextBranchId !== target.branchId) {
    const branch = await db.branch.findFirst({ where: { id: nextBranchId, organisationId: target.organisationId ?? undefined } });
    if (!branch || !canAccessScope(access.user, branch.organisationId, branch.id)) return withCors(apiError(400, "INVALID_BRANCH", "Branch does not belong to the organisation"), request);
  }
  if (nextRole === "CASHIER" && !nextBranchId) return withCors(apiError(400, "INVALID_USER", "Cashiers need a branch"), request);
  if (nextRole === "CASHIER" && !target.pinHash && !body.pin) return withCors(apiError(400, "INVALID_USER", "Cashiers need a PIN"), request);
  if (nextRole !== "CASHIER" && !target.credentialHash && !body.credential) return withCors(apiError(400, "INVALID_USER", "Owners and admins need a password"), request);

  const user = await db.user.update({
    where: { id: target.id },
    data: {
      ...(body.name?.trim() ? { name: body.name.trim() } : {}),
      role: nextRole,
      branchId: nextBranchId,
      ...(typeof body.isActive === "boolean" ? { isActive: body.isActive } : {}),
      ...(body.credential ? { credentialHash: await hashCredential(body.credential) } : {}),
      ...(body.pin ? { pinHash: await hashCredential(body.pin) } : {}),
      ...(body.maxDiscountPercent !== undefined ? { maxDiscountPercent: body.maxDiscountPercent } : {})
    },
    select: userFields
  });

  const roleChanged = nextRole !== target.role;
  const deactivated = body.isActive === false && target.isActive;
  if (roleChanged || deactivated || body.credential || body.pin || nextBranchId !== target.branchId) await revokeUserSessions(target.id);

  const audit = { organisationId: target.organisationId ?? undefined, branchId: user.branchId ?? undefined, userId: access.user.id, entityType: "user", entityId: target.id };
  if (roleChanged) await recordAudit({ ...audit, action: "user.role_changed", metadata: { from: toRoleName(target.role), to: toRoleName(nextRole) } });
  if (typeof body.isActive === "boolean" && body.isActive !== target.isActive) await recordAudit({ ...audit, action: body.isActive ? "user.reactivated" : "user.deactivated" });
  if (body.credential) await recordAudit({ ...audit, action: "user.credential_reset" });
  if (body.pin) await recordAudit({ ...audit, action: "user.pin_reset" });
  if (body.maxDiscountPercent !== undefined && body.maxDiscountPercent !== target.maxDiscountPercent) await recordAudit({ ...audit, action: "user.discount_limit_changed", metadata: { from: target.maxDiscountPercent, to: body.maxDiscountPercent } });
  if (nextBranchId !== target.branchId) await recordAudit({ ...audit, action: "user.branch_changed", metadata: { from: target.branchId, to: nextBranchId } });

  return withCors(Response.json({ user: toUserSummary(user) }, { headers: { "x-api-version": "v1" } }), request);
}
