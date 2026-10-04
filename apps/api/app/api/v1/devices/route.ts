import { db } from "@pharmica/database/client";
import { canAccessScope, newActivationCode, recordAudit, requireAuth } from "../../../../src/auth/authorization";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";

// Never return the device secret hash.
const deviceFields = { id: true, branchId: true, name: true, activationCode: true, activatedAt: true, isActive: true, lastSeenAt: true, createdAt: true } as const;

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);

  const organisationId = new URL(request.url).searchParams.get("organisationId") ?? access.user.organisationId;
  if (!organisationId || !canAccessScope(access.user, organisationId)) return withCors(apiError(403, "FORBIDDEN", "Organisation access denied"), request);
  const devices = await db.device.findMany({ where: { branch: { organisationId } }, select: deviceFields, orderBy: { createdAt: "asc" } });
  return withCors(Response.json({ devices }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { branchId?: string; name?: string } | null;
  if (!body?.branchId || !body.name?.trim()) return withCors(apiError(400, "INVALID_DEVICE", "Branch and device name are required"), request);

  const branch = await db.branch.findUnique({ where: { id: body.branchId } });
  if (!branch || !canAccessScope(access.user, branch.organisationId, branch.id)) return withCors(apiError(403, "FORBIDDEN", "Branch access denied"), request);

  const device = await db.device.create({ data: { branchId: branch.id, name: body.name.trim(), activationCode: newActivationCode() }, select: deviceFields });
  await recordAudit({ organisationId: branch.organisationId, branchId: branch.id, userId: access.user.id, action: "device.created", entityType: "device", entityId: device.id });
  return withCors(Response.json({ device }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}

/** Activate/deactivate a device, or `resetActivation` to issue a new code (e.g. replacing the counter PC). */
export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { deviceId?: string; isActive?: boolean; resetActivation?: boolean } | null;
  if (!body?.deviceId || (typeof body.isActive !== "boolean" && body.resetActivation !== true)) return withCors(apiError(400, "INVALID_DEVICE", "Device ID and an active state or activation reset are required"), request);

  const device = await db.device.findUnique({ where: { id: body.deviceId }, include: { branch: true } });
  if (!device || !canAccessScope(access.user, device.branch.organisationId, device.branchId)) return withCors(apiError(403, "FORBIDDEN", "Device access denied"), request);

  const updated = await db.$transaction(async (transaction) => {
    const result = await transaction.device.update({
      where: { id: device.id },
      data: {
        ...(typeof body.isActive === "boolean" ? { isActive: body.isActive } : {}),
        ...(body.resetActivation ? { activationCode: newActivationCode(), secretHash: null, activatedAt: null } : {})
      },
      select: deviceFields
    });
    if (body.isActive === false || body.resetActivation) {
      await transaction.session.updateMany({ where: { deviceId: device.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return result;
  });

  const audit = { organisationId: device.branch.organisationId, branchId: device.branchId, userId: access.user.id, entityType: "device", entityId: device.id };
  if (typeof body.isActive === "boolean" && body.isActive !== device.isActive) await recordAudit({ ...audit, action: body.isActive ? "device.activated" : "device.deactivated" });
  if (body.resetActivation) await recordAudit({ ...audit, action: "device.activation_reset" });
  return withCors(Response.json({ device: updated }, { headers: { "x-api-version": "v1" } }), request);
}
