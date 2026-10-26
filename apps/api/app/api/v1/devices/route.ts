import { db } from "@pharmica/database/client";
import { canAccessScope, recordAudit, requireAuth } from "../../../../src/auth/authorization";
import { counterName, nextCounterNumber } from "../../../../src/devices/naming";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";
import { requireRoomFor } from "../../../../src/billing/subscriptions";

// Never return the device secret hash.
const deviceFields = { id: true, branchId: true, name: true, counterNumber: true, activatedAt: true, isActive: true, lastSeenAt: true, createdAt: true, diagnostics: true, diagnosticsAt: true } as const;

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);

  const organisationId = new URL(request.url).searchParams.get("organisationId") ?? access.user.organisationId;
  if (!organisationId || !canAccessScope(access.user, organisationId)) return withCors(apiError(403, "FORBIDDEN", "Organisation access denied"), request);
  const [organisation, devices] = await Promise.all([
    db.organisation.findUnique({ where: { id: organisationId }, select: { shopCode: true } }),
    db.device.findMany({ where: { branch: { organisationId } }, select: deviceFields, orderBy: { counterNumber: "asc" } })
  ]);
  return withCors(Response.json({ shopCode: organisation?.shopCode ?? null, devices }, { headers: { "x-api-version": "v1" } }), request);
}

/** Adds a counter. Its name is always `<shopCode>-<number>`; the number is the one asked for, or the next free one. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { branchId?: string; counterNumber?: number } | null;
  if (!body?.branchId) return withCors(apiError(400, "INVALID_DEVICE", "Choose the branch for this counter"), request);
  if (body.counterNumber !== undefined && (!Number.isInteger(body.counterNumber) || body.counterNumber < 1 || body.counterNumber > 9999)) {
    return withCors(apiError(400, "INVALID_DEVICE", "The counter number must be a whole number from 1 to 9999"), request);
  }

  const branch = await db.branch.findUnique({ where: { id: body.branchId }, include: { organisation: { select: { shopCode: true } } } });
  if (!branch || !canAccessScope(access.user, branch.organisationId, branch.id)) return withCors(apiError(403, "FORBIDDEN", "Branch access denied"), request);

  const full = await requireRoomFor(branch.organisationId, "devices");
  if (full) return withCors(full, request);

  const created = await db.$transaction(async (tx) => {
    const counterNumber = body.counterNumber ?? await nextCounterNumber(tx, branch.organisationId);
    const name = counterName(branch.organisation.shopCode, counterNumber);
    if (await tx.device.findUnique({ where: { name }, select: { id: true } })) return null;
    return tx.device.create({ data: { branchId: branch.id, name, counterNumber }, select: deviceFields });
  }).catch(() => null);
  if (!created) return withCors(apiError(409, "COUNTER_NUMBER_TAKEN", "That counter number is already used. Pick another number"), request);

  await recordAudit({ organisationId: branch.organisationId, branchId: branch.id, userId: access.user.id, action: "device.created", entityType: "device", entityId: created.id });
  return withCors(Response.json({ device: created }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}

/** Turns a counter on or off, or `unlink`s it from its computer (e.g. replacing the counter PC) so it can be linked again. */
export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { deviceId?: string; isActive?: boolean; unlink?: boolean } | null;
  if (!body?.deviceId || (typeof body.isActive !== "boolean" && body.unlink !== true)) return withCors(apiError(400, "INVALID_DEVICE", "Device ID and an active state or unlink are required"), request);

  const device = await db.device.findUnique({ where: { id: body.deviceId }, include: { branch: true } });
  if (!device || !canAccessScope(access.user, device.branch.organisationId, device.branchId)) return withCors(apiError(403, "FORBIDDEN", "Device access denied"), request);

  if (body.isActive === true && !device.isActive) {
    const full = await requireRoomFor(device.branch.organisationId, "devices");
    if (full) return withCors(full, request);
  }

  const updated = await db.$transaction(async (transaction) => {
    const result = await transaction.device.update({
      where: { id: device.id },
      data: {
        ...(typeof body.isActive === "boolean" ? { isActive: body.isActive } : {}),
        ...(body.unlink ? { secretHash: null, activatedAt: null } : {})
      },
      select: deviceFields
    });
    if (body.isActive === false || body.unlink) {
      await transaction.session.updateMany({ where: { deviceId: device.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return result;
  });

  const audit = { organisationId: device.branch.organisationId, branchId: device.branchId, userId: access.user.id, entityType: "device", entityId: device.id };
  if (typeof body.isActive === "boolean" && body.isActive !== device.isActive) await recordAudit({ ...audit, action: body.isActive ? "device.activated" : "device.deactivated" });
  if (body.unlink) await recordAudit({ ...audit, action: "device.unlinked" });
  return withCors(Response.json({ device: updated }, { status: 200, headers: { "x-api-version": "v1" } }), request);
}
