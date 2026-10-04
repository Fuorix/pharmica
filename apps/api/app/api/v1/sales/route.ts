import type { PaymentMethod, SaleSummary } from "@pharmica/contracts";
import { ledgerBalance } from "@pharmica/domain";
import { db } from "@pharmica/database/client";
import { z } from "zod";
import { recordAudit, requireAuth, requireBranch } from "../../../../src/auth/authorization";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";
import { money, parseBody } from "../../../../src/lib/validation";
import { recordSaleMovements, SaleError, takeStockForSale, toSaleLineRows } from "../../../../src/sales/create-sale";
import { roundMoney } from "@pharmica/domain";

const paymentMap: Record<PaymentMethod, "CASH" | "CARD" | "CREDIT"> = { cash: "CASH", card: "CARD", credit: "CREDIT" };

const saleSchema = z.object({
  branchId: z.string().min(1),
  customerId: z.string().min(1).optional(),
  paymentMethod: z.enum(["cash", "card", "credit"]),
  discount: money.default(0),
  lines: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().int().positive().max(100_000),
    unit: z.enum(["pack", "strip", "tablet"]),
    unitPrice: money.optional()
  })).min(1).max(200)
}).refine((sale) => sale.paymentMethod !== "credit" || sale.customerId, { message: "A customer is required for credit sales", path: ["customerId"] });

type SaleRow = { id: string; branchId: string; subtotal: unknown; discount: unknown; total: unknown; paymentMethod: "CASH" | "CARD" | "CREDIT"; status: "COMPLETED" | "VOIDED" | "RETURNED"; createdAt: Date; lines?: Array<{ productId: string; batchId: string | null; quantity: number; unit: "PACK" | "STRIP" | "TABLET"; unitPrice: unknown; lineTotal: unknown }> };

function saleSummary(sale: SaleRow): SaleSummary {
  return {
    id: sale.id,
    branchId: sale.branchId,
    subtotal: Number(sale.subtotal),
    discount: Number(sale.discount),
    total: Number(sale.total),
    paymentMethod: sale.paymentMethod.toLowerCase() as SaleSummary["paymentMethod"],
    status: sale.status.toLowerCase() as SaleSummary["status"],
    createdAt: sale.createdAt.toISOString(),
    ...(sale.lines ? {
      lines: sale.lines.map((line) => ({ productId: line.productId, batchId: line.batchId, quantity: line.quantity, unit: line.unit.toLowerCase() as "pack" | "strip" | "tablet", unitPrice: Number(line.unitPrice), lineTotal: Number(line.lineTotal) }))
    } : {})
  };
}

export function OPTIONS(request: Request): Response {
  return corsOptions(request);
}

export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request);
  if ("response" in access) return withCors(access.response, request);
  const scope = await requireBranch(access.user, new URL(request.url).searchParams.get("branchId"));
  if ("response" in scope) return withCors(scope.response, request);

  const sales = await db.sale.findMany({ where: { branchId: scope.branch.id }, orderBy: { createdAt: "desc" }, take: 50 });
  return withCors(Response.json({ sales: sales.map(saleSummary) }, { headers: { "x-api-version": "v1" } }), request);
}

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, undefined, { device: true });
  if ("response" in access) return withCors(access.response, request);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || undefined;
  if (idempotencyKey) {
    const existing = await db.sale.findUnique({ where: { idempotencyKey }, include: { lines: true } });
    if (existing) return withCors(Response.json({ sale: saleSummary(existing) }, { headers: { "x-api-version": "v1", "x-idempotent-replay": "true" } }), request);
  }

  const parsed = await parseBody(request, saleSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const body = parsed.data;
  const scope = await requireBranch(access.user, body.branchId);
  if ("response" in scope) return withCors(scope.response, request);
  const branch = scope.branch;
  const customer = body.customerId ? await db.customer.findFirst({ where: { id: body.customerId, branchId: branch.id } }) : null;
  if (body.customerId && !customer) return withCors(apiError(404, "CUSTOMER_NOT_FOUND", "Customer was not found in this branch"), request);

  let sale;
  try {
    sale = await db.$transaction(async (transaction) => {
      const lines = await takeStockForSale(transaction, { branchId: branch.id, userId: access.user.id, lines: body.lines });
      const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.lineTotal, 0));
      if (body.discount > subtotal) throw new SaleError(400, "INVALID_DISCOUNT", "Discount cannot exceed the bill subtotal");
      const total = roundMoney(subtotal - body.discount);

      if (body.paymentMethod === "credit" && customer) {
        const entries = await transaction.customerLedgerEntry.findMany({ where: { customerId: customer.id }, select: { type: true, amount: true } });
        const balance = ledgerBalance(entries);
        if (Number(customer.creditLimit) > 0 && balance + total > Number(customer.creditLimit)) throw new SaleError(409, "CREDIT_LIMIT_EXCEEDED", "Customer credit limit would be exceeded");
      }

      const created = await transaction.sale.create({
        data: { branchId: branch.id, userId: access.user.id, customerId: body.customerId, idempotencyKey, subtotal, discount: body.discount, total, paymentMethod: paymentMap[body.paymentMethod], lines: { create: toSaleLineRows(lines) } },
        include: { lines: true }
      });
      await recordSaleMovements(transaction, { branchId: branch.id, userId: access.user.id, saleId: created.id, lines });
      if (body.paymentMethod === "credit" && customer) {
        await transaction.customerLedgerEntry.create({ data: { branchId: branch.id, customerId: customer.id, userId: access.user.id, type: "CREDIT_SALE", amount: total, note: `Sale ${created.id}`, saleId: created.id } });
      }
      return created;
    });
  } catch (error) {
    if (error instanceof SaleError) return withCors(apiError(error.status, error.code, error.message), request);
    return withCors(apiError(500, "SALE_UNAVAILABLE", "The sale could not be completed"), request);
  }

  await recordAudit({ organisationId: branch.organisationId, branchId: branch.id, userId: access.user.id, action: "sale.created", entityType: "sale", entityId: sale.id, metadata: { total: Number(sale.total), paymentMethod: body.paymentMethod, deviceId: access.user.deviceId } });
  return withCors(Response.json({ sale: saleSummary(sale) }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}
