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
  const bills = await db.heldBill.findMany({ where: { branchId }, orderBy: { updatedAt: "desc" } });
  return withCors(Response.json({ bills }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, undefined, { device: true });
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { branchId?: string; label?: string; payload?: unknown } | null;
  if (!body?.branchId || !body.payload) return withCors(apiError(400, "INVALID_HELD_BILL", "Branch and bill payload are required"), request);
  const branch = await db.branch.findUnique({ where: { id: body.branchId } });
  if (!branch || !canAccessScope(access.user, branch.organisationId, branch.id)) return withCors(apiError(403, "FORBIDDEN", "Branch access denied"), request);
  const bill = await db.heldBill.create({ data: { branchId: branch.id, userId: access.user.id, label: body.label?.trim(), payload: body.payload as object } });
  await recordAudit({ organisationId: branch.organisationId, branchId: branch.id, userId: access.user.id, action: "bill.held", entityType: "held_bill", entityId: bill.id });
  return withCors(Response.json({ bill }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}

export async function DELETE(request: Request): Promise<Response> {
  const access = await requireAuth(request, undefined, { device: true });
  if ("response" in access) return withCors(access.response, request);
  const billId = new URL(request.url).searchParams.get("id");
  if (!billId) return withCors(apiError(400, "BILL_REQUIRED", "Held bill ID is required"), request);
  const bill = await db.heldBill.findUnique({ where: { id: billId }, include: { branch: true } });
  if (!bill || !canAccessScope(access.user, bill.branch.organisationId, bill.branchId)) return withCors(apiError(403, "FORBIDDEN", "Held bill access denied"), request);
  await db.heldBill.delete({ where: { id: bill.id } });
  await recordAudit({ organisationId: bill.branch.organisationId, branchId: bill.branchId, userId: access.user.id, action: "bill.resumed", entityType: "held_bill", entityId: bill.id });
  return withCors(new Response(null, { status: 204 }), request);
}
