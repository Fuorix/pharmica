import { db } from "@pharmica/database/client";
import { canAccessScope, requireAuth } from "../../../../../src/auth/authorization";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const deviceId = new URL(request.url).searchParams.get("deviceId");
  const device = deviceId ? await db.device.findUnique({ where: { id: deviceId } }) : null;
  const branch = device ? await db.branch.findUnique({ where: { id: device.branchId } }) : null;
  if (!device || !branch || !canAccessScope(access.user, branch.organisationId, device.branchId)) return withCors(apiError(403, "DEVICE_ACCESS_DENIED", "Device access denied"), request);
  const conflicts = await db.syncOperation.findMany({ where: { deviceId: device.id, status: "CONFLICT" }, orderBy: { createdAt: "desc" }, take: 100 });
  return withCors(Response.json({ conflicts }, { headers: { "x-api-version": "v1" } }), request);
}
