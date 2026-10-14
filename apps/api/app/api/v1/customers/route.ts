import { db } from "@pharmica/database/client";
import { z } from "zod";
import { recordAudit, requireAuth, requireBranch } from "../../../../src/auth/authorization";
import { toReceivable } from "../../../../src/accounts/accounts";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";
import { money, parseBody } from "../../../../src/lib/validation";

const phone = z.string().trim().max(30).optional().transform((value) => value || null);
const createSchema = z.object({ branchId: z.string().min(1), name: z.string().trim().min(1).max(120), phone, creditLimit: money.nullable().default(0) });
// For updates, a missing phone means "no change"; an empty one clears it.
const updateSchema = z.object({ customerId: z.string().min(1), name: z.string().trim().min(1).max(120).optional(), phone: z.string().trim().max(30).nullable().optional().transform((value) => value === undefined ? undefined : value || null), creditLimit: money.nullable().optional(), isActive: z.boolean().optional() });

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/**
 * Customers with what they owe, aged by the oldest unpaid credit. `status=owing` keeps customers with a balance;
 * `status=overdue&days=30` keeps those owing for longer than that.
 */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request);
  if ("response" in access) return withCors(access.response, request);
  const params = new URL(request.url).searchParams;
  const scope = await requireBranch(access.user, params.get("branchId"));
  if ("response" in scope) return withCors(scope.response, request);

  const customers = await db.customer.findMany({ where: { branchId: scope.branch.id }, include: { ledger: { select: { type: true, amount: true, createdAt: true } } }, orderBy: { name: "asc" } });
  let summaries = customers.map((customer) => toReceivable(customer));
  const status = params.get("status");
  const days = Number(params.get("days") ?? 30);
  if (status === "owing") summaries = summaries.filter((customer) => customer.balance > 0);
  if (status === "overdue") summaries = summaries.filter((customer) => customer.balance > 0 && customer.daysOutstanding > days);
  return withCors(Response.json({ customers: summaries }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "cashier", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const parsed = await parseBody(request, createSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const scope = await requireBranch(access.user, parsed.data.branchId);
  if ("response" in scope) return withCors(scope.response, request);
  if (parsed.data.phone && await db.customer.findUnique({ where: { branchId_phone: { branchId: scope.branch.id, phone: parsed.data.phone } } })) {
    return withCors(apiError(409, "PHONE_IN_USE", "Another customer already has that phone number"), request);
  }
  const customer = await db.customer.create({ data: { branchId: scope.branch.id, name: parsed.data.name, phone: parsed.data.phone, creditLimit: parsed.data.creditLimit }, include: { ledger: true } });
  await recordAudit({ organisationId: scope.branch.organisationId, branchId: scope.branch.id, userId: access.user.id, action: "customer.created", entityType: "customer", entityId: customer.id });
  return withCors(Response.json({ customer: toReceivable(customer) }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}

/** Owner edits: name, phone, credit limit, or deactivating a customer (their history is kept). */
export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const parsed = await parseBody(request, updateSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const existing = await db.customer.findUnique({ where: { id: parsed.data.customerId } });
  if (!existing) return withCors(apiError(404, "CUSTOMER_NOT_FOUND", "Customer was not found"), request);
  const scope = await requireBranch(access.user, existing.branchId);
  if ("response" in scope) return withCors(scope.response, request);

  const { customerId: _customerId, ...changes } = parsed.data;
  if (changes.phone && changes.phone !== existing.phone && await db.customer.findUnique({ where: { branchId_phone: { branchId: existing.branchId, phone: changes.phone } } })) {
    return withCors(apiError(409, "PHONE_IN_USE", "Another customer already has that phone number"), request);
  }
  const customer = await db.customer.update({
    where: { id: existing.id },
    data: { ...(changes.name ? { name: changes.name } : {}), ...(changes.phone !== undefined ? { phone: changes.phone } : {}), ...(changes.creditLimit !== undefined ? { creditLimit: changes.creditLimit } : {}), ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}) },
    include: { ledger: true }
  });
  await recordAudit({ organisationId: scope.branch.organisationId, branchId: existing.branchId, userId: access.user.id, action: "customer.updated", entityType: "customer", entityId: existing.id, metadata: { creditLimit: changes.creditLimit, isActive: changes.isActive } });
  return withCors(Response.json({ customer: toReceivable(customer) }, { headers: { "x-api-version": "v1" } }), request);
}
