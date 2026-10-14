import { db } from "@pharmica/database/client";
import { canAccessScope, recordAudit, requireAuth } from "../../../../../src/auth/authorization";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const access = await requireAuth(request);
  if ("response" in access) return withCors(access.response, request);
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { action?: "void" | "return"; reason?: string } | null;
  if (!body?.action || !body.reason?.trim()) return withCors(apiError(400, "INVALID_SALE_ACTION", "Action and reason are required"), request);
  const sale = await db.sale.findUnique({ where: { id }, include: { branch: true } });
  if (!sale || !canAccessScope(access.user, sale.branch.organisationId, sale.branchId)) return withCors(apiError(403, "FORBIDDEN", "Sale access denied"), request);
  if (sale.status !== "COMPLETED") return withCors(apiError(409, "SALE_ALREADY_CHANGED", "Only completed sales can be changed"), request);
  const status = body.action === "void" ? "VOIDED" : "RETURNED";
  const updated = await db.sale.update({ where: { id }, data: { status } });
  await recordAudit({ organisationId: sale.branch.organisationId, branchId: sale.branchId, userId: access.user.id, action: `sale.${body.action}`, entityType: "sale", entityId: sale.id, metadata: { reason: body.reason.trim() } });
  return withCors(Response.json({ sale: updated }, { headers: { "x-api-version": "v1" } }), request);
}
