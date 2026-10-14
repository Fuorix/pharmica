import { db } from "@pharmica/database/client";
import { z } from "zod";
import { recordAudit, requireAuth, requireBranch } from "../../../../src/auth/authorization";
import { toPayable } from "../../../../src/accounts/accounts";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";
import { parseBody } from "../../../../src/lib/validation";

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((value) => value === undefined ? undefined : value || null);
const createSchema = z.object({ branchId: z.string().min(1), name: z.string().trim().min(1).max(120), phone: optionalText(30), address: optionalText(200) });
const updateSchema = z.object({ supplierId: z.string().min(1), name: z.string().trim().min(1).max(120).optional(), phone: optionalText(30), address: optionalText(200), isActive: z.boolean().optional() });

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** Suppliers with what the shop owes them (payables), aged by the oldest unpaid invoice. `status=owing` keeps those with a balance. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const params = new URL(request.url).searchParams;
  const scope = await requireBranch(access.user, params.get("branchId"));
  if ("response" in scope) return withCors(scope.response, request);
  const suppliers = await db.supplier.findMany({ where: { branchId: scope.branch.id }, include: { ledger: { select: { type: true, amount: true, createdAt: true } } }, orderBy: { name: "asc" } });
  let summaries = suppliers.map((supplier) => toPayable(supplier));
  if (params.get("status") === "owing") summaries = summaries.filter((supplier) => supplier.balance > 0);
  return withCors(Response.json({ suppliers: summaries }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const parsed = await parseBody(request, createSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const scope = await requireBranch(access.user, parsed.data.branchId);
  if ("response" in scope) return withCors(scope.response, request);
  if (await db.supplier.findUnique({ where: { branchId_name: { branchId: scope.branch.id, name: parsed.data.name } } })) return withCors(apiError(409, "SUPPLIER_EXISTS", "A supplier with that name already exists"), request);
  const supplier = await db.supplier.create({ data: { branchId: scope.branch.id, name: parsed.data.name, phone: parsed.data.phone, address: parsed.data.address }, include: { ledger: true } });
  await recordAudit({ organisationId: scope.branch.organisationId, branchId: scope.branch.id, userId: access.user.id, action: "supplier.created", entityType: "supplier", entityId: supplier.id });
  return withCors(Response.json({ supplier: toPayable(supplier) }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}

export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const parsed = await parseBody(request, updateSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const existing = await db.supplier.findUnique({ where: { id: parsed.data.supplierId } });
  if (!existing) return withCors(apiError(404, "SUPPLIER_NOT_FOUND", "Supplier was not found"), request);
  const scope = await requireBranch(access.user, existing.branchId);
  if ("response" in scope) return withCors(scope.response, request);
  const { supplierId: _supplierId, ...changes } = parsed.data;
  if (changes.name && changes.name !== existing.name && await db.supplier.findUnique({ where: { branchId_name: { branchId: existing.branchId, name: changes.name } } })) {
    return withCors(apiError(409, "SUPPLIER_EXISTS", "A supplier with that name already exists"), request);
  }
  const supplier = await db.supplier.update({
    where: { id: existing.id },
    data: { ...(changes.name ? { name: changes.name } : {}), ...(changes.phone !== undefined ? { phone: changes.phone } : {}), ...(changes.address !== undefined ? { address: changes.address } : {}), ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}) },
    include: { ledger: true }
  });
  await recordAudit({ organisationId: scope.branch.organisationId, branchId: existing.branchId, userId: access.user.id, action: "supplier.updated", entityType: "supplier", entityId: existing.id });
  return withCors(Response.json({ supplier: toPayable(supplier) }, { headers: { "x-api-version": "v1" } }), request);
}
