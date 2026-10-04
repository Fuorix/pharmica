import { db } from "@pharmica/database/client";
import { canAccessScope, recordAudit, requireAuth } from "../../../../src/auth/authorization";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const branchId = new URL(request.url).searchParams.get("branchId") ?? access.user.branchId;
  if (!branchId) return withCors(apiError(400, "BRANCH_REQUIRED", "A branch is required"), request);
  const branch = await db.branch.findUnique({ where: { id: branchId } });
  if (!branch || !canAccessScope(access.user, branch.organisationId, branch.id)) return withCors(apiError(403, "FORBIDDEN", "Branch access denied"), request);
  const records = await db.controlledDrugRecord.findMany({ where: { branchId }, include: { product: true, sale: true }, orderBy: { createdAt: "desc" }, take: 100 });
  return withCors(Response.json({ records }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "cashier", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { branchId?: string; productId?: string; saleId?: string; patientName?: string; doctorName?: string; quantity?: number; notes?: string } | null;
  if (!body?.branchId || !body.productId || !body.patientName || !body.doctorName || !body.quantity || body.quantity <= 0) return withCors(apiError(400, "INVALID_CONTROLLED_DRUG_RECORD", "Branch, product, patient, doctor, and quantity are required"), request);
  const branch = await db.branch.findUnique({ where: { id: body.branchId } });
  const product = await db.product.findFirst({ where: { id: body.productId, branchId: body.branchId }, include: { masterProduct: true } });
  if (!branch || !product || !canAccessScope(access.user, branch.organisationId, branch.id) || !product.masterProduct?.isControlled) return withCors(apiError(403, "CONTROLLED_PRODUCT_REQUIRED", "A controlled product in the selected branch is required"), request);
  const record = await db.controlledDrugRecord.create({ data: { branchId: branch.id, userId: access.user.id, productId: product.id, saleId: body.saleId, patientName: body.patientName.trim(), doctorName: body.doctorName.trim(), quantity: body.quantity, notes: body.notes?.trim() } });
  await recordAudit({ organisationId: branch.organisationId, branchId: branch.id, userId: access.user.id, action: "controlled_drug.recorded", entityType: "controlled_drug_record", entityId: record.id });
  return withCors(Response.json({ record }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}
