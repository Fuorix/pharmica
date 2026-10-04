import { db } from "@pharmica/database/client";
import { canAccessScope, requireAuth } from "../../../../../src/auth/authorization";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, undefined, { device: true });
  if ("response" in access) return withCors(access.response, request);
  const params = new URL(request.url).searchParams;
  const deviceId = params.get("deviceId");
  const cursor = Number(params.get("cursor") ?? 0);
  if (!deviceId || !Number.isInteger(cursor) || cursor < 0) return withCors(apiError(400, "INVALID_SYNC_CURSOR", "Device ID and cursor are required"), request);
  const device = await db.device.findUnique({ where: { id: deviceId } });
  const branch = device ? await db.branch.findUnique({ where: { id: device.branchId } }) : null;
  if (!device || !branch || !device.isActive || device.id !== access.user.deviceId || !canAccessScope(access.user, branch.organisationId, device.branchId)) return withCors(apiError(403, "DEVICE_ACCESS_DENIED", "Device access denied"), request);
  const changes = await db.syncChange.findMany({ where: { branchId: device.branchId, cursor: { gt: cursor } }, orderBy: { cursor: "asc" }, take: 100 });
  const nextCursor = changes.at(-1)?.cursor ?? cursor;
  await db.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  return withCors(Response.json({ changes, nextCursor, hasMore: changes.length === 100 }, { headers: { "x-api-version": "v1" } }), request);
}
