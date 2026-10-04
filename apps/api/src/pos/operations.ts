import type { PosSyncResult } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { discountWithinLimit, ledgerBalance, packStructure, refundFor, roundMoney, sellableUnits, unitPrice, unitSize } from "@pharmica/domain";
import { z } from "zod";
import { adjustStock, applyCount, receivePurchase, StockError, type StockContext } from "../inventory/stock";
import { money } from "../lib/validation";

const id = z.string().min(1).max(64);
const paymentMethod = z.enum(["cash", "card", "credit"]);
const base = { id, userId: id, occurredAt: z.iso.datetime({ offset: true }) };

export const operationSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("shift.open"), payload: z.object({ shiftId: id, openingCash: money }) }),
  z.object({ ...base, type: z.literal("shift.close"), payload: z.object({ shiftId: id, closingCash: money, report: z.unknown() }) }),
  z.object({ ...base, type: z.literal("customer.create"), payload: z.object({ customerId: id, name: z.string().trim().min(1).max(120), phone: z.string().trim().max(30).optional(), creditLimit: money.optional() }) }),
  z.object({
    ...base,
    type: z.literal("sale"),
    payload: z.object({
      saleId: id,
      receiptNo: z.string().trim().min(1).max(40),
      shiftId: id.optional(),
      customerId: id.optional(),
      paymentMethod,
      billDiscount: money,
      total: money,
      lines: z.array(z.object({ lineId: id, productId: id, batchId: id, unit: z.enum(["pack", "strip", "tablet"]), quantity: z.number().int().positive().max(100_000), unitPrice: money, discount: money })).min(1).max(200)
    })
  }),
  z.object({ ...base, type: z.literal("sale.void"), payload: z.object({ saleId: id, reason: z.string().trim().min(1).max(300) }) }),
  z.object({ ...base, type: z.literal("sale.return"), payload: z.object({ returnId: id, saleId: id, reason: z.string().trim().min(1).max(300), refundMethod: paymentMethod, lines: z.array(z.object({ saleLineId: id, quantity: z.number().int().positive() })).min(1) }) }),
  z.object({ ...base, type: z.literal("purchase.receive"), payload: z.object({ purchaseId: id, supplier: z.object({ id: id.optional(), name: z.string().trim().min(1).max(120), phone: z.string().trim().max(30).optional() }), invoiceNumber: z.string().trim().max(60).optional(), invoiceDate: z.iso.date().optional(), invoiceDiscount: money, lines: z.array(z.object({ lineId: id.optional(), productId: id.optional(), masterProductId: id.optional(), batchId: id.optional(), batchNo: z.string().trim().min(1).max(40), expiryDate: z.iso.date(), quantity: z.number().int().nonnegative().max(1_000_000), bonusQuantity: z.number().int().nonnegative().max(1_000_000), costPrice: money, discount: money, retailPrice: money, serialNumber: z.string().trim().max(40).optional() }).refine((line) => line.productId || line.masterProductId, "Each line needs a product")).min(1).max(300) }) }),
  z.object({ ...base, type: z.literal("stock.adjust"), payload: z.object({ adjustmentId: id, batchId: id, type: z.enum(["WRITE_OFF", "DAMAGE", "EXPIRY", "ADJUSTMENT"]), quantity: z.number().int(), reason: z.string().trim().min(1).max(300) }) }),
  z.object({ ...base, type: z.literal("stock.count"), payload: z.object({ countId: id, reason: z.string().trim().max(300), lines: z.array(z.object({ batchId: id, expected: z.number().int().nonnegative(), counted: z.number().int().nonnegative() })).min(1).max(500) }) }),
  z.object({ ...base, type: z.literal("product.update"), payload: z.object({ productId: id, rackLocation: z.string().trim().max(40).nullable().optional(), lowStockThreshold: z.number().int().nonnegative().max(100_000).optional() }) }),
  z.object({ ...base, type: z.literal("audit"), payload: z.object({ action: z.string().trim().min(1).max(80), entityType: z.string().trim().min(1).max(60), entityId: z.string().max(64).optional(), metadata: z.record(z.string(), z.unknown()).optional() }) })
]);

export type Operation = z.infer<typeof operationSchema>;

/** A rejected operation: it would record something that cannot have happened legitimately. */
export class OperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type Device = { id: string; branchId: string; branch: { organisationId: string } };
type Tx = Prisma.TransactionClient;
type Context = { tx: Tx; device: Device; operation: Operation; flags: string[] };

const paymentMap = { cash: "CASH", card: "CARD", credit: "CREDIT" } as const;
const unitMap = { pack: "PACK", strip: "STRIP", tablet: "TABLET" } as const;

async function audit(context: Context, action: string, entityType: string, entityId: string | undefined, metadata?: Record<string, unknown>) {
  await context.tx.auditLog.create({
    data: { organisationId: context.device.branch.organisationId, branchId: context.device.branchId, userId: context.operation.userId, action, entityType, entityId, metadata: { deviceId: context.device.id, occurredAt: context.operation.occurredAt, ...metadata } as Prisma.InputJsonValue }
  });
}

/** Puts stock back on the batch it was sold from. */
async function restoreStock(context: Context, saleId: string, line: { productId: string; batchId: string | null; quantity: number; unit: "PACK" | "STRIP" | "TABLET"; product: Parameters<typeof packStructure>[0] }, quantity: number, reason: string) {
  if (!line.batchId) return;
  const baseUnits = quantity * unitSize(line.unit.toLowerCase() as "pack" | "strip" | "tablet", packStructure(line.product));
  await context.tx.batch.update({ where: { id: line.batchId }, data: { quantity: { increment: baseUnits } } });
  await context.tx.stockMovement.create({ data: { branchId: context.device.branchId, productId: line.productId, batchId: line.batchId, userId: context.operation.userId, type: "SALE_RETURN", quantity: baseUnits, reason, referenceId: saleId } });
}

async function applySale(context: Context, payload: Extract<Operation, { type: "sale" }>["payload"]) {
  const { tx, device, operation } = context;
  const branchId = device.branchId;
  if (await tx.sale.findUnique({ where: { id: payload.saleId } })) throw new OperationError("SALE_EXISTS", "A different operation already recorded this sale");
  if (payload.shiftId && !await tx.shift.findFirst({ where: { id: payload.shiftId, branchId } })) throw new OperationError("SHIFT_NOT_FOUND", "The sale's shift is not known to the server");
  const customer = payload.customerId ? await tx.customer.findFirst({ where: { id: payload.customerId, branchId }, include: { ledger: true } }) : null;
  if (payload.customerId && !customer) throw new OperationError("CUSTOMER_NOT_FOUND", "The sale's customer is not known to the server");
  if (payload.paymentMethod === "credit" && !customer) throw new OperationError("CUSTOMER_REQUIRED", "Credit sales need a customer");

  const products = new Map((await tx.product.findMany({ where: { id: { in: payload.lines.map((line) => line.productId) }, branchId }, include: { masterProduct: true, batches: { where: { id: { in: payload.lines.map((line) => line.batchId) } } } } })).map((product) => [product.id, product]));
  const lines = payload.lines.map((line) => {
    const product = products.get(line.productId);
    const batch = product?.batches.find((candidate) => candidate.id === line.batchId);
    if (!product || !batch) throw new OperationError("UNKNOWN_STOCK", "A sold item or batch does not belong to this branch");
    const structure = packStructure(product);
    if (!sellableUnits(structure).includes(line.unit)) throw new OperationError("INVALID_UNIT", `${product.name} cannot be sold by the ${line.unit}`);
    // The printed retail price of the batch is the legal ceiling; anything above it can only come from tampering.
    if (line.unitPrice > unitPrice(Number(batch.retailPrice), line.unit, structure) + 0.005) throw new OperationError("ABOVE_RETAIL_PRICE", `${product.name} was priced above its retail price`);
    const gross = roundMoney(line.quantity * line.unitPrice);
    if (line.discount > gross) throw new OperationError("INVALID_DISCOUNT", "A line discount is larger than the line");
    return { ...line, product, gross, lineTotal: roundMoney(gross - line.discount), baseUnits: line.quantity * unitSize(line.unit, structure) };
  });

  const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.gross, 0));
  const itemDiscount = roundMoney(lines.reduce((sum, line) => sum + line.discount, 0));
  if (payload.billDiscount > roundMoney(subtotal - itemDiscount)) throw new OperationError("INVALID_DISCOUNT", "The bill discount is larger than the bill");
  const discount = roundMoney(itemDiscount + payload.billDiscount);
  const total = roundMoney(subtotal - discount);
  if (Math.abs(total - payload.total) > 0.01) context.flags.push("TOTAL_MISMATCH");

  const user = await tx.user.findUniqueOrThrow({ where: { id: operation.userId } });
  if (!discountWithinLimit(subtotal, discount, user.role === "OWNER" ? null : user.maxDiscountPercent)) context.flags.push("DISCOUNT_OVER_LIMIT");
  if (customer && payload.paymentMethod === "credit" && Number(customer.creditLimit) > 0) {
    if (ledgerBalance(customer.ledger) + total > Number(customer.creditLimit) + 0.005) context.flags.push("CREDIT_LIMIT_EXCEEDED");
  }

  // The goods have already left the counter, so the sale is always recorded. If another counter sold the
  // same stock first, the batch is emptied and the shortfall is flagged for the owner instead.
  const shortfalls: Array<{ batchId: string; productId: string; missing: number }> = [];
  for (const line of lines) {
    const taken = await tx.batch.updateMany({ where: { id: line.batchId, quantity: { gte: line.baseUnits } }, data: { quantity: { decrement: line.baseUnits } } });
    if (taken.count === 1) continue;
    const batch = await tx.batch.findUniqueOrThrow({ where: { id: line.batchId } });
    shortfalls.push({ batchId: line.batchId, productId: line.productId, missing: line.baseUnits - batch.quantity });
    await tx.batch.update({ where: { id: line.batchId }, data: { quantity: 0 } });
  }
  if (shortfalls.length) context.flags.push("OVERSOLD");

  const sale = await tx.sale.create({
    data: {
      id: payload.saleId,
      branchId,
      userId: operation.userId,
      deviceId: device.id,
      shiftId: payload.shiftId,
      receiptNo: payload.receiptNo,
      customerId: payload.customerId,
      subtotal,
      discount,
      total,
      paymentMethod: paymentMap[payload.paymentMethod],
      createdAt: new Date(operation.occurredAt),
      lines: { create: lines.map((line) => ({ id: line.lineId, productId: line.productId, batchId: line.batchId, quantity: line.quantity, unit: unitMap[line.unit], unitPrice: line.unitPrice, discount: line.discount, lineTotal: line.lineTotal })) }
    }
  });
  await tx.stockMovement.createMany({ data: lines.map((line) => ({ branchId, productId: line.productId, batchId: line.batchId, userId: operation.userId, type: "SALE" as const, quantity: -line.baseUnits, reason: "Sale", referenceId: sale.id, createdAt: new Date(operation.occurredAt) })) });
  // The ledger records the full sale; a matching correction keeps it equal to the emptied batch until someone counts.
  for (const shortfall of shortfalls) {
    await tx.stockMovement.create({ data: { branchId, productId: shortfall.productId, batchId: shortfall.batchId, userId: operation.userId, type: "ADJUSTMENT", quantity: shortfall.missing, reason: "Sold beyond recorded stock while offline; count this item", referenceId: sale.id, createdAt: new Date(operation.occurredAt) } });
  }
  if (payload.paymentMethod === "credit" && customer) {
    await tx.customerLedgerEntry.create({ data: { branchId, customerId: customer.id, userId: operation.userId, type: "CREDIT_SALE", amount: total, note: `Receipt ${payload.receiptNo}`, saleId: sale.id, createdAt: new Date(operation.occurredAt) } });
  }
  await audit(context, "sale.created", "sale", sale.id, { total, discount, paymentMethod: payload.paymentMethod, receiptNo: payload.receiptNo, flags: context.flags });
  if (shortfalls.length) await audit(context, "stock.oversold", "sale", sale.id, { shortfalls });
  if (context.flags.includes("DISCOUNT_OVER_LIMIT")) await audit(context, "sale.discount_over_limit", "sale", sale.id, { discount, subtotal, limit: user.maxDiscountPercent });
}

async function saleWithLines(context: Context, saleId: string) {
  const sale = await context.tx.sale.findFirst({ where: { id: saleId, branchId: context.device.branchId }, include: { lines: { include: { product: { include: { masterProduct: true } }, returnLines: true } }, returns: true } });
  if (!sale) throw new OperationError("SALE_NOT_FOUND", "The sale is not known to the server");
  return sale;
}

async function applyVoid(context: Context, payload: Extract<Operation, { type: "sale.void" }>["payload"]) {
  const sale = await saleWithLines(context, payload.saleId);
  if (sale.status !== "COMPLETED") throw new OperationError("SALE_ALREADY_CHANGED", "Only completed sales can be voided");
  if (sale.returns.length) throw new OperationError("SALE_HAS_RETURNS", "A sale with returns cannot be voided");
  for (const line of sale.lines) await restoreStock(context, sale.id, line, line.quantity, "Void");
  await context.tx.sale.update({ where: { id: sale.id }, data: { status: "VOIDED", voidedAt: new Date(context.operation.occurredAt), voidedById: context.operation.userId, voidReason: payload.reason } });
  if (sale.paymentMethod === "CREDIT" && sale.customerId) {
    await context.tx.customerLedgerEntry.create({ data: { branchId: sale.branchId, customerId: sale.customerId, userId: context.operation.userId, type: "CREDIT_RETURN", amount: sale.total, note: `Void of receipt ${sale.receiptNo ?? sale.id}`, saleId: sale.id } });
  }
  await audit(context, "sale.voided", "sale", sale.id, { reason: payload.reason, total: Number(sale.total) });
}

async function applyReturn(context: Context, payload: Extract<Operation, { type: "sale.return" }>["payload"]) {
  const sale = await saleWithLines(context, payload.saleId);
  if (sale.status === "VOIDED") throw new OperationError("SALE_VOIDED", "A voided sale cannot be returned");
  const refund = refundFor(Number(sale.total), sale.lines.map((line) => ({ id: line.id, quantity: line.quantity, lineTotal: Number(line.lineTotal), returned: line.returnLines.reduce((sum, item) => sum + item.quantity, 0) })), payload.lines);
  if ("error" in refund) throw new OperationError("INVALID_RETURN", refund.error);
  // Credit sales are refunded by reducing what the customer owes.
  const refundMethod = sale.paymentMethod === "CREDIT" ? "credit" : payload.refundMethod;

  await context.tx.saleReturn.create({
    data: { id: payload.returnId, saleId: sale.id, branchId: sale.branchId, userId: context.operation.userId, deviceId: context.device.id, reason: payload.reason, refundMethod: paymentMap[refundMethod], refundAmount: refund.amount, createdAt: new Date(context.operation.occurredAt), lines: { create: refund.lines } }
  });
  for (const item of refund.lines) {
    const line = sale.lines.find((candidate) => candidate.id === item.saleLineId)!;
    await restoreStock(context, sale.id, line, item.quantity, "Return");
  }
  if (refundMethod === "credit" && sale.customerId) {
    await context.tx.customerLedgerEntry.create({ data: { branchId: sale.branchId, customerId: sale.customerId, userId: context.operation.userId, type: "CREDIT_RETURN", amount: refund.amount, note: `Return on receipt ${sale.receiptNo ?? sale.id}`, saleId: sale.id } });
  }
  const fullyReturned = sale.lines.every((line) => line.returnLines.reduce((sum, item) => sum + item.quantity, 0) + (refund.lines.find((item) => item.saleLineId === line.id)?.quantity ?? 0) >= line.quantity);
  if (fullyReturned) await context.tx.sale.update({ where: { id: sale.id }, data: { status: "RETURNED" } });
  await audit(context, "sale.returned", "sale", sale.id, { returnId: payload.returnId, reason: payload.reason, refund: refund.amount, refundMethod });
}

function stockContext(context: Context): StockContext {
  return { branchId: context.device.branchId, organisationId: context.device.branch.organisationId, userId: context.operation.userId, deviceId: context.device.id, at: new Date(context.operation.occurredAt) };
}

async function applyOperation(context: Context): Promise<void> {
  const { tx, device, operation } = context;
  switch (operation.type) {
    case "shift.open":
      await tx.shift.create({ data: { id: operation.payload.shiftId, branchId: device.branchId, deviceId: device.id, userId: operation.userId, openingCash: operation.payload.openingCash, openedAt: new Date(operation.occurredAt) } });
      await audit(context, "shift.opened", "shift", operation.payload.shiftId, { openingCash: operation.payload.openingCash });
      return;
    case "shift.close": {
      const shift = await tx.shift.findFirst({ where: { id: operation.payload.shiftId, branchId: device.branchId } });
      if (!shift) throw new OperationError("SHIFT_NOT_FOUND", "The shift is not known to the server");
      await tx.shift.update({ where: { id: shift.id }, data: { status: "CLOSED", closingCash: operation.payload.closingCash, closedAt: new Date(operation.occurredAt), closingReport: operation.payload.report as Prisma.InputJsonValue } });
      await audit(context, "shift.closed", "shift", shift.id, { closingCash: operation.payload.closingCash });
      return;
    }
    case "customer.create": {
      const { customerId, name, phone, creditLimit } = operation.payload;
      // Two counters may add the same phone number while offline; keep the customer and drop the clash.
      const phoneTaken = phone ? await tx.customer.findUnique({ where: { branchId_phone: { branchId: device.branchId, phone } } }) : null;
      if (phoneTaken) context.flags.push("DUPLICATE_PHONE");
      await tx.customer.create({ data: { id: customerId, branchId: device.branchId, name, phone: phoneTaken ? null : phone, creditLimit: creditLimit ?? 0, createdAt: new Date(operation.occurredAt) } });
      await audit(context, "customer.created", "customer", customerId);
      return;
    }
    case "sale": return applySale(context, operation.payload);
    case "sale.void": return applyVoid(context, operation.payload);
    case "sale.return": return applyReturn(context, operation.payload);
    case "purchase.receive": {
      const { warnings } = await receivePurchase(tx, stockContext(context), operation.payload);
      if (warnings.length) context.flags.push(...warnings.map((warning) => `NOTE: ${warning}`));
      return;
    }
    case "stock.adjust": {
      const { shortBy } = await adjustStock(tx, stockContext(context), operation.payload);
      if (shortBy) context.flags.push("ADJUSTED_TO_AVAILABLE");
      return;
    }
    case "stock.count":
      await applyCount(tx, stockContext(context), operation.payload);
      return;
    case "product.update": {
      const product = await tx.product.findFirst({ where: { id: operation.payload.productId, branchId: device.branchId } });
      if (!product) throw new OperationError("PRODUCT_NOT_FOUND", "The product is not in this branch");
      const { rackLocation, lowStockThreshold } = operation.payload;
      await tx.product.update({ where: { id: product.id }, data: { ...(rackLocation !== undefined ? { rackLocation: rackLocation || null } : {}), ...(lowStockThreshold !== undefined ? { lowStockThreshold } : {}) } });
      await audit(context, "product.updated", "product", product.id, { rackLocation, lowStockThreshold });
      return;
    }
    case "audit": return audit(context, `pos.${operation.payload.action}`, operation.payload.entityType, operation.payload.entityId, operation.payload.metadata);
  }
}

/**
 * Applies one uploaded operation exactly once. The operation and its idempotency record commit together,
 * so a retried upload is reported as a duplicate instead of being applied twice.
 */
export async function processOperation(device: Device, raw: unknown): Promise<PosSyncResult> {
  const rawId = typeof raw === "object" && raw && "id" in raw && typeof raw.id === "string" ? raw.id : "unknown";
  const parsed = operationSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { id: rawId, status: "failed", error: { code: "VALIDATION_FAILED", message: `${issue.path.join(".")}: ${issue.message}` } };
  }
  const operation = parsed.data;

  const existing = await db.syncOperation.findUnique({ where: { idempotencyKey: operation.id } });
  if (existing && existing.deviceId !== device.id) return { id: operation.id, status: "failed", error: { code: "OPERATION_ID_CLASH", message: "This operation id belongs to another device" } };
  if (existing?.status === "APPLIED") return { id: operation.id, status: "duplicate" };

  const user = await db.user.findUnique({ where: { id: operation.userId } });
  if (!user || !user.isActive || user.role === "SUPER_ADMIN" || user.organisationId !== device.branch.organisationId || (user.branchId && user.branchId !== device.branchId)) {
    return record(device, operation, { id: operation.id, status: "failed", error: { code: "USER_NOT_ALLOWED", message: "The user is not allowed to work at this counter" } });
  }

  const flags: string[] = [];
  try {
    await db.$transaction(async (tx) => {
      await applyOperation({ tx, device, operation, flags });
      await tx.syncOperation.upsert({
        where: { idempotencyKey: operation.id },
        create: { idempotencyKey: operation.id, deviceId: device.id, branchId: device.branchId, entityType: operation.type, payload: operation as unknown as Prisma.InputJsonValue, status: "APPLIED", processedAt: new Date(), errorMessage: flags.length ? flags.join(",") : null },
        update: { status: "APPLIED", processedAt: new Date(), retryCount: { increment: 1 }, errorMessage: flags.length ? flags.join(",") : null }
      });
    });
    return { id: operation.id, status: "applied", ...(flags.length ? { flags } : {}) };
  } catch (error) {
    const failure = error instanceof OperationError || error instanceof StockError ? { code: error.code, message: error.message } : { code: "OPERATION_FAILED", message: "The server could not apply this operation" };
    return record(device, operation, { id: operation.id, status: "failed", error: failure });
  }
}

async function record(device: Device, operation: Operation, result: PosSyncResult): Promise<PosSyncResult> {
  await db.syncOperation.upsert({
    where: { idempotencyKey: operation.id },
    create: { idempotencyKey: operation.id, deviceId: device.id, branchId: device.branchId, entityType: operation.type, payload: operation as unknown as Prisma.InputJsonValue, status: "FAILED", errorMessage: `${result.error?.code}: ${result.error?.message}`, processedAt: new Date() },
    update: { status: "FAILED", errorMessage: `${result.error?.code}: ${result.error?.message}`, processedAt: new Date(), retryCount: { increment: 1 } }
  });
  return result;
}
