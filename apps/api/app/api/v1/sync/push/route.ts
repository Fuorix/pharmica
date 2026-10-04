import type { SyncOperationRequest } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { canAccessScope, recordAudit, requireAuth } from "../../../../../src/auth/authorization";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, undefined, { device: true });
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { operations?: SyncOperationRequest[] } | null;
  if (!body?.operations?.length) return withCors(apiError(400, "INVALID_SYNC_PUSH", "At least one sync operation is required"), request);
  const device = await db.device.findUnique({ where: { id: body.operations[0].deviceId } });
  if (!device || !device.isActive || device.id !== access.user.deviceId || !canAccessScope(access.user, access.user.organisationId ?? "", device.branchId)) return withCors(apiError(403, "DEVICE_ACCESS_DENIED", "Device access denied"), request);
  if (body.operations.some((operation) => operation.deviceId !== device.id)) return withCors(apiError(400, "MIXED_DEVICES", "A push batch may contain one device only"), request);

  const results = [];
  for (const operation of body.operations) {
    const existing = await db.syncOperation.findUnique({ where: { idempotencyKey: operation.idempotencyKey }, include: { changes: true } });
    if (existing) { results.push({ idempotencyKey: operation.idempotencyKey, status: existing.status, cursor: existing.changes[0]?.cursor ?? null }); continue; }
    const latest = await db.syncChange.findFirst({ where: { branchId: device.branchId, entityType: operation.entityType, entityId: operation.entityId }, orderBy: { version: "desc" } });
    const incomingVersion = operation.version ?? 1;
    if (latest && incomingVersion < latest.version) {
      const conflict = await db.syncOperation.create({ data: { idempotencyKey: operation.idempotencyKey, deviceId: device.id, branchId: device.branchId, entityType: operation.entityType, payload: operation.payload as object, status: "CONFLICT", errorMessage: "Incoming version is older than the server version", processedAt: new Date() } });
      results.push({ idempotencyKey: operation.idempotencyKey, status: conflict.status, cursor: null });
      continue;
    }
    const applied = await db.$transaction(async (transaction) => {
      const syncOperation = await transaction.syncOperation.create({ data: { idempotencyKey: operation.idempotencyKey, deviceId: device.id, branchId: device.branchId, entityType: operation.entityType, payload: operation.payload as object, status: "APPLIED", processedAt: new Date() } });
      const change = await transaction.syncChange.create({ data: { branchId: device.branchId, deviceId: device.id, operationId: syncOperation.idempotencyKey, entityType: operation.entityType, entityId: operation.entityId, version: incomingVersion, payload: operation.payload as object } });
      return { syncOperation, change };
    });
    results.push({ idempotencyKey: operation.idempotencyKey, status: applied.syncOperation.status, cursor: applied.change.cursor });
    await recordAudit({ organisationId: access.user.organisationId ?? undefined, branchId: device.branchId, userId: access.user.id, action: "sync.operation_applied", entityType: operation.entityType, entityId: operation.entityId, metadata: { idempotencyKey: operation.idempotencyKey } });
  }
  await db.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  return withCors(Response.json({ results }, { headers: { "x-api-version": "v1" } }), request);
}
