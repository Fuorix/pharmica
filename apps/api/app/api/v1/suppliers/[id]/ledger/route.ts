import { db } from "@pharmica/database/client";
import { z } from "zod";
import { requireAuth, requireBranch } from "../../../../../../src/auth/authorization";
import { AccountError, adjustSupplier, recordSupplierPayment, toLedgerLines, toPayable } from "../../../../../../src/accounts/accounts";
import { apiError } from "../../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../../src/lib/cors";
import { parseBody } from "../../../../../../src/lib/validation";

const entrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PAYMENT"), amount: z.number().finite().positive(), method: z.enum(["cash", "bank", "cheque"]), reference: z.string().trim().max(60).optional(), note: z.string().trim().max(200).optional() }),
  z.object({ type: z.literal("ADJUSTMENT"), amount: z.number().finite().refine((value) => value !== 0, "Cannot be zero"), reason: z.string().trim().min(1, "A reason is required").max(300) })
]);

type Context = { params: Promise<{ id: string }> };

async function supplierInScope(request: Request, context: Context) {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return access;
  const { id } = await context.params;
  const supplier = await db.supplier.findUnique({ where: { id } });
  if (!supplier) return { response: apiError(404, "SUPPLIER_NOT_FOUND", "Supplier was not found") };
  const scope = await requireBranch(access.user, supplier.branchId);
  if ("response" in scope) return scope;
  return { user: access.user, supplier, branch: scope.branch };
}

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** Purchases, payments, and adjustments with this supplier, and what is still owed. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const found = await supplierInScope(request, context);
  if ("response" in found) return withCors(found.response, request);
  const entries = await db.supplierLedgerEntry.findMany({ where: { supplierId: found.supplier.id }, include: { user: { select: { name: true } } } });
  return withCors(Response.json({ supplier: toPayable({ ...found.supplier, ledger: entries }), entries: toLedgerLines(entries) }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const found = await supplierInScope(request, context);
  if ("response" in found) return withCors(found.response, request);
  const parsed = await parseBody(request, entrySchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const accountContext = { branchId: found.branch.id, organisationId: found.branch.organisationId, userId: found.user.id };
  try {
    const body = parsed.data;
    const entry = await db.$transaction((tx) => body.type === "PAYMENT"
      ? recordSupplierPayment(tx, accountContext, { supplierId: found.supplier.id, amount: body.amount, method: body.method, reference: body.reference, note: body.note })
      : adjustSupplier(tx, accountContext, { supplierId: found.supplier.id, amount: body.amount, reason: body.reason }));
    return withCors(Response.json({ entry: { id: entry.id, type: entry.type, amount: Number(entry.amount) } }, { status: 201, headers: { "x-api-version": "v1" } }), request);
  } catch (error) {
    if (error instanceof AccountError) return withCors(apiError(400, error.code, error.message), request);
    throw error;
  }
}
