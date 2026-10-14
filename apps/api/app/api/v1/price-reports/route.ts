import { db } from "@pharmica/database/client";
import { canAccessScope, requireAuth } from "../../../../src/auth/authorization";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const branchId = new URL(request.url).searchParams.get("branchId") ?? access.user.branchId;
  const branch = branchId ? await db.branch.findUnique({ where: { id: branchId } }) : null;
  if (!branch || !canAccessScope(access.user, branch.organisationId, branch.id)) return withCors(apiError(403, "FORBIDDEN", "Branch access denied"), request);
  const reports = await db.priceChangeReport.findMany({ where: { branchId: branch.id, status: "PENDING" }, include: { product: { include: { masterProduct: true } }, batch: { select: { batchNo: true, expiryDate: true } }, purchase: { select: { invoiceNumber: true, supplier: { select: { name: true } } } } }, orderBy: { createdAt: "desc" } });
  return withCors(Response.json({ reports }, { headers: { "x-api-version": "v1" } }), request);
}
