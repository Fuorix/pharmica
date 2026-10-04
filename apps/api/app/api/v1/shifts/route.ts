import { db } from "@pharmica/database/client";
import { canAccessScope, recordAudit, requireAuth } from "../../../../src/auth/authorization";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request);
  if ("response" in access) return withCors(access.response, request);
  const branchId = new URL(request.url).searchParams.get("branchId") ?? access.user.branchId;
  if (!branchId) return withCors(apiError(400, "BRANCH_REQUIRED", "A branch is required"), request);
  const branch = await db.branch.findUnique({ where: { id: branchId } });
  if (!branch || !canAccessScope(access.user, branch.organisationId, branch.id)) return withCors(apiError(403, "FORBIDDEN", "Branch access denied"), request);
  const shift = await db.shift.findFirst({ where: { branchId, status: "OPEN" }, orderBy: { openedAt: "desc" } });
  return withCors(Response.json({ shift }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, undefined, { device: true });
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { branchId?: string; openingCash?: number } | null;
  if (!body?.branchId || typeof body.openingCash !== "number" || body.openingCash < 0) return withCors(apiError(400, "INVALID_SHIFT", "Branch and non-negative opening cash are required"), request);
  const branch = await db.branch.findUnique({ where: { id: body.branchId } });
  if (!branch || !canAccessScope(access.user, branch.organisationId, branch.id)) return withCors(apiError(403, "FORBIDDEN", "Branch access denied"), request);
  const existing = await db.shift.findFirst({ where: { branchId: branch.id, status: "OPEN" } });
  if (existing) return withCors(apiError(409, "SHIFT_ALREADY_OPEN", "This branch already has an open shift"), request);
  const shift = await db.shift.create({ data: { branchId: branch.id, userId: access.user.id, openingCash: body.openingCash } });
  await recordAudit({ organisationId: branch.organisationId, branchId: branch.id, userId: access.user.id, action: "shift.opened", entityType: "shift", entityId: shift.id, metadata: { openingCash: body.openingCash } });
  return withCors(Response.json({ shift }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}

export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAuth(request, undefined, { device: true });
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { shiftId?: string; closingCash?: number } | null;
  if (!body?.shiftId || typeof body.closingCash !== "number" || body.closingCash < 0) return withCors(apiError(400, "INVALID_SHIFT", "Shift and non-negative closing cash are required"), request);
  const shift = await db.shift.findUnique({ where: { id: body.shiftId }, include: { branch: true } });
  if (!shift || shift.status !== "OPEN" || !canAccessScope(access.user, shift.branch.organisationId, shift.branchId)) return withCors(apiError(403, "FORBIDDEN", "Open shift access denied"), request);
  const updated = await db.shift.update({ where: { id: shift.id }, data: { status: "CLOSED", closingCash: body.closingCash, closedAt: new Date() } });
  await recordAudit({ organisationId: shift.branch.organisationId, branchId: shift.branchId, userId: access.user.id, action: "shift.closed", entityType: "shift", entityId: shift.id, metadata: { closingCash: body.closingCash } });
  return withCors(Response.json({ shift: updated }, { headers: { "x-api-version": "v1" } }), request);
}
