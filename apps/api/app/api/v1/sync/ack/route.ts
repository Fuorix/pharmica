import { db } from "@pharmica/database/client";
import { canAccessScope, requireAuth } from "../../../../../src/auth/authorization";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, undefined, { device: true });
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { deviceId?: string; cursor?: number } | null;
  const cursor = body?.cursor;
  if (!body?.deviceId || typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) return withCors(apiError(400, "INVALID_SYNC_ACK", "Device ID and cursor are required"), request);
  const device = await db.device.findUnique({ where: { id: body.deviceId } });
  const branch = device ? await db.branch.findUnique({ where: { id: device.branchId } }) : null;
  if (!device || !branch || device.id !== access.user.deviceId || !canAccessScope(access.user, branch.organisationId, device.branchId)) return withCors(apiError(403, "DEVICE_ACCESS_DENIED", "Device access denied"), request);
  const latest = await db.syncChange.findFirst({ where: { branchId: device.branchId }, orderBy: { cursor: "desc" }, select: { cursor: true } });
  if (latest && cursor > latest.cursor) return withCors(apiError(409, "INVALID_SYNC_CURSOR", "Cursor is ahead of the server"), request);
  const updated = await db.device.update({ where: { id: device.id }, data: { syncCursor: cursor, lastSeenAt: new Date() } });
  return withCors(Response.json({ deviceId: updated.id, cursor: updated.syncCursor }, { headers: { "x-api-version": "v1" } }), request);
}