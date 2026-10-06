import type { BatchStatus, InventoryItem, PurchaseSummary, ReceivePurchaseRequest, StockAdjustmentType } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { averageCost, NEAR_EXPIRY_DAYS, packStructure, purchaseTotals, roundMoney, stockStatus, unitSize } from "@pharmica/domain";
import { resolveCurrentPrice } from "../catalogue/master-price";

type Tx = Prisma.TransactionClient;
export type StockContext = { branchId: string; organisationId: string; userId: string; deviceId?: string; at?: Date };

/** A request that cannot be applied, e.g. stock that has already expired or a product from another branch. */
export class StockError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const DAY = 86_400_000;
const toDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** The official price a master product has today, from its price history (falls back to the stored price). */
async function officialPrice(tx: Tx, masterProductId: string, now: Date): Promise<number | null> {
  const history = await tx.masterPriceHistory.findMany({ where: { masterProductId } });
  const current = resolveCurrentPrice(history.map((entry) => ({ ...entry, price: Number(entry.price) })), now);
  if (current) return current.price;
  const master = await tx.masterProduct.findUnique({ where: { id: masterProductId } });
  return master?.officialRetailPrice == null ? null : Number(master.officialRetailPrice);
}

/**
 * Receives a supplier invoice: creates or tops up batches, records every pack in the stock ledger, books the
 * payable to the supplier, and reports retail prices that differ from the master list. Returns warnings the
 * person receiving should see.
 */
export async function receivePurchase(tx: Tx, context: StockContext, input: Omit<ReceivePurchaseRequest, "branchId">): Promise<{ purchaseId: string; warnings: string[] }> {
  const now = context.at ?? new Date();
  const warnings: string[] = [];
  const totals = purchaseTotals(input.lines.map((line) => ({ quantity: line.quantity, bonusQuantity: line.bonusQuantity, costPrice: line.costPrice, discount: line.discount })), input.invoiceDiscount);
  if ("error" in totals) throw new StockError("INVALID_PURCHASE", totals.error);
  if (input.purchaseId && await tx.purchase.findUnique({ where: { id: input.purchaseId } })) throw new StockError("PURCHASE_EXISTS", "This purchase was already received");

  const supplierName = input.supplier.name.trim();
  const supplier = input.supplier.id
    ? await tx.supplier.findFirst({ where: { id: input.supplier.id, branchId: context.branchId } })
    : await tx.supplier.upsert({ where: { branchId_name: { branchId: context.branchId, name: supplierName } }, update: {}, create: { branchId: context.branchId, name: supplierName, phone: input.supplier.phone?.trim() || undefined } });
  if (!supplier) throw new StockError("SUPPLIER_NOT_FOUND", "Supplier was not found in this branch");

  const invoiceNumber = input.invoiceNumber?.trim() || undefined;
  if (invoiceNumber && await tx.purchase.findFirst({ where: { supplierId: supplier.id, invoiceNumber } })) {
    warnings.push(`Invoice ${invoiceNumber} from ${supplier.name} was already received once. Check it is not a duplicate`);
  }

  const purchase = await tx.purchase.create({
    data: {
      id: input.purchaseId,
      branchId: context.branchId,
      supplierId: supplier.id,
      userId: context.userId,
      deviceId: context.deviceId,
      invoiceNumber,
      invoiceDate: input.invoiceDate ? toDate(input.invoiceDate) : undefined,
      subtotal: totals.subtotal,
      lineDiscount: totals.lineDiscount,
      tradeDiscount: totals.invoiceDiscount,
      total: totals.total,
      bonusPacks: totals.bonusPacks,
      receivedAt: now
    }
  });

  for (const [index, line] of input.lines.entries()) {
    const priced = totals.lines[index];
    const label = `Line ${index + 1}`;
    const expiry = toDate(line.expiryDate);
    if (Number.isNaN(expiry.getTime())) throw new StockError("INVALID_EXPIRY", `${label}: the expiry date is not valid`);
    if (expiry.getTime() <= now.getTime()) throw new StockError("EXPIRED_STOCK", `${label}: this batch has already expired and cannot be received`);

    let product = line.productId ? await tx.product.findFirst({ where: { id: line.productId, branchId: context.branchId }, include: { masterProduct: true } }) : null;
    if (!product && line.masterProductId) {
      const master = await tx.masterProduct.findUnique({ where: { id: line.masterProductId } });
      if (!master) throw new StockError("PRODUCT_NOT_FOUND", `${label}: the medicine is not on the master list`);
      product = await tx.product.upsert({
        where: { branchId_masterProductId: { branchId: context.branchId, masterProductId: master.id } },
        update: { isActive: true },
        // A counter that received this medicine offline chose the product id itself; keep it.
        create: { id: line.productId, branchId: context.branchId, masterProductId: master.id, name: master.name, generic: master.generic, barcode: master.barcode },
        include: { masterProduct: true }
      });
    }
    if (!product) throw new StockError("PRODUCT_NOT_FOUND", `${label}: the item is not in this branch`);
    if (expiry.getTime() - now.getTime() < NEAR_EXPIRY_DAYS * DAY) warnings.push(`${product.name}: batch ${line.batchNo} expires within ${NEAR_EXPIRY_DAYS} days`);

    const perPack = unitSize("pack", packStructure(product));
    const packs = line.quantity + line.bonusQuantity;
    const baseUnits = packs * perPack;
    const batchNo = line.batchNo.trim();
    const existing = await tx.batch.findUnique({ where: { productId_batchNo: { productId: product.id, batchNo } } });
    let batchId: string;
    if (existing) {
      if (existing.expiryDate.getTime() !== expiry.getTime()) warnings.push(`${product.name}: batch ${batchNo} is already on the shelf with expiry ${existing.expiryDate.toISOString().slice(0, 10)}; kept that date`);
      if (Number(existing.retailPrice) !== line.retailPrice) warnings.push(`${product.name}: batch ${batchNo} is already priced PKR ${Number(existing.retailPrice).toFixed(2)}; kept that price`);
      await tx.batch.update({
        where: { id: existing.id },
        data: { quantity: { increment: baseUnits }, costPrice: averageCost({ quantity: existing.quantity / perPack, cost: existing.costPrice == null ? null : Number(existing.costPrice) }, { quantity: packs, cost: priced.effectiveCost }) }
      });
      batchId = existing.id;
    } else {
      const created = await tx.batch.create({
        data: { id: line.batchId, productId: product.id, batchNo, expiryDate: expiry, quantity: baseUnits, costPrice: priced.effectiveCost, retailPrice: line.retailPrice, retailPriceSource: `Purchase from ${supplier.name}`, serialNumber: line.serialNumber, createdAt: now }
      });
      batchId = created.id;
    }

    await tx.purchaseLine.create({
      data: { purchaseId: purchase.id, productId: product.id, batchId, quantity: line.quantity, bonusQuantity: line.bonusQuantity, costPrice: line.costPrice, retailPrice: line.retailPrice, tradeDiscount: priced.discount, invoiceDiscount: priced.invoiceDiscount, effectiveCost: priced.effectiveCost, serialNumber: line.serialNumber }
    });
    await tx.stockMovement.create({ data: { branchId: context.branchId, productId: product.id, batchId, userId: context.userId, type: "RECEIPT", quantity: baseUnits, reason: `Purchase from ${supplier.name}${invoiceNumber ? ` (invoice ${invoiceNumber})` : ""}`, referenceId: purchase.id, createdAt: now } });

    // A printed price different from the official master price goes to the review queue.
    if (product.masterProductId && !existing) {
      const official = await officialPrice(tx, product.masterProductId, now);
      if (official != null && Math.abs(official - line.retailPrice) > 0.005) {
        const alreadyReported = await tx.priceChangeReport.findFirst({ where: { productId: product.id, newPrice: line.retailPrice, status: "PENDING" } });
        if (!alreadyReported) {
          await tx.priceChangeReport.create({ data: { branchId: context.branchId, productId: product.id, batchId, purchaseId: purchase.id, reportedById: context.userId, oldPrice: official, newPrice: line.retailPrice, source: "DISTRIBUTOR_INVOICE" } });
        }
        warnings.push(`${product.name}: printed price PKR ${line.retailPrice.toFixed(2)} differs from the master price PKR ${official.toFixed(2)}; reported for review`);
      }
    }
  }

  if (totals.total > 0) {
    await tx.supplierLedgerEntry.create({ data: { branchId: context.branchId, supplierId: supplier.id, userId: context.userId, type: "PURCHASE", amount: totals.total, note: `Invoice ${invoiceNumber ?? "(no number)"}`, purchaseId: purchase.id, createdAt: now } });
  }
  await tx.auditLog.create({ data: { organisationId: context.organisationId, branchId: context.branchId, userId: context.userId, action: "purchase.received", entityType: "purchase", entityId: purchase.id, metadata: { supplier: supplier.name, invoiceNumber, total: totals.total, lines: input.lines.length, bonusPacks: totals.bonusPacks, deviceId: context.deviceId } } });
  return { purchaseId: purchase.id, warnings };
}

const movementType: Record<StockAdjustmentType, "WRITE_OFF" | "DAMAGE" | "EXPIRY" | "ADJUSTMENT"> = { WRITE_OFF: "WRITE_OFF", DAMAGE: "DAMAGE", EXPIRY: "EXPIRY", ADJUSTMENT: "ADJUSTMENT" };

/**
 * Changes a batch's stock by `delta` base units with a reason, and records it in the ledger. Stock never goes
 * below zero: a removal larger than what the server holds takes what is there and reports the difference.
 */
export async function changeStock(tx: Tx, context: StockContext, input: { batchId: string; delta: number; type: "WRITE_OFF" | "DAMAGE" | "EXPIRY" | "ADJUSTMENT" | "COUNT"; reason: string; referenceId?: string }): Promise<{ applied: number; shortBy: number }> {
  if (!input.reason.trim()) throw new StockError("REASON_REQUIRED", "A reason is required for every stock change");
  if (!Number.isInteger(input.delta) || input.delta === 0) throw new StockError("INVALID_QUANTITY", "The change must be a whole, non-zero number of units");
  if (input.delta > 0 && input.type !== "ADJUSTMENT" && input.type !== "COUNT") throw new StockError("INVALID_QUANTITY", "Write-offs, damage, and expiry can only remove stock");
  const batch = await tx.batch.findFirst({ where: { id: input.batchId, product: { branchId: context.branchId } } });
  if (!batch) throw new StockError("BATCH_NOT_FOUND", "The batch is not in this branch");

  const applied = input.delta < 0 ? -Math.min(batch.quantity, -input.delta) : input.delta;
  if (applied !== 0) {
    await tx.batch.update({ where: { id: batch.id }, data: { quantity: { increment: applied } } });
    await tx.stockMovement.create({ data: { branchId: context.branchId, productId: batch.productId, batchId: batch.id, userId: context.userId, type: input.type, quantity: applied, reason: input.reason.trim(), referenceId: input.referenceId, createdAt: context.at } });
  }
  return { applied, shortBy: applied - input.delta };
}

export async function adjustStock(tx: Tx, context: StockContext, input: { adjustmentId?: string; batchId: string; type: StockAdjustmentType; quantity: number; reason: string }) {
  const result = await changeStock(tx, context, { batchId: input.batchId, delta: input.quantity, type: movementType[input.type], reason: input.reason, referenceId: input.adjustmentId });
  await tx.auditLog.create({ data: { organisationId: context.organisationId, branchId: context.branchId, userId: context.userId, action: `stock.${input.type.toLowerCase()}`, entityType: "batch", entityId: input.batchId, metadata: { requested: input.quantity, applied: result.applied, reason: input.reason, deviceId: context.deviceId } } });
  return result;
}

/** Applies a physical count. Only the difference the counter saw is applied, so sales made elsewhere meanwhile are kept. */
export async function applyCount(tx: Tx, context: StockContext, input: { countId: string; reason: string; lines: Array<{ batchId: string; expected: number; counted: number }> }) {
  const results: Array<{ batchId: string; delta: number; applied: number }> = [];
  for (const line of input.lines) {
    if (!Number.isInteger(line.counted) || line.counted < 0) throw new StockError("INVALID_QUANTITY", "Counted quantities must be whole numbers");
    const delta = line.counted - line.expected;
    if (delta === 0) { results.push({ batchId: line.batchId, delta, applied: 0 }); continue; }
    const { applied } = await changeStock(tx, context, { batchId: line.batchId, delta, type: "COUNT", reason: input.reason || "Physical count", referenceId: input.countId });
    results.push({ batchId: line.batchId, delta, applied });
  }
  await tx.auditLog.create({ data: { organisationId: context.organisationId, branchId: context.branchId, userId: context.userId, action: "stock.counted", entityType: "count", entityId: input.countId, metadata: { lines: results, reason: input.reason, deviceId: context.deviceId } } });
  return results;
}

export const purchaseInclude = {
  supplier: true,
  user: { select: { name: true } },
  lines: { include: { product: { include: { masterProduct: true } }, batch: true } }
} satisfies Prisma.PurchaseInclude;

export function toPurchaseSummary(purchase: Prisma.PurchaseGetPayload<{ include: typeof purchaseInclude }>): PurchaseSummary {
  return {
    id: purchase.id,
    supplier: { id: purchase.supplier.id, name: purchase.supplier.name },
    invoiceNumber: purchase.invoiceNumber,
    invoiceDate: purchase.invoiceDate?.toISOString().slice(0, 10) ?? null,
    receivedAt: purchase.receivedAt.toISOString(),
    receivedBy: purchase.user.name,
    subtotal: Number(purchase.subtotal),
    lineDiscount: Number(purchase.lineDiscount),
    invoiceDiscount: Number(purchase.tradeDiscount),
    total: Number(purchase.total),
    bonusPacks: purchase.bonusPacks,
    lines: purchase.lines.map((line) => ({
      productId: line.productId,
      name: line.product.masterProduct?.name ?? line.product.name,
      batchNo: line.batch.batchNo,
      expiryDate: line.batch.expiryDate.toISOString().slice(0, 10),
      quantity: line.quantity,
      bonusQuantity: line.bonusQuantity,
      costPrice: Number(line.costPrice),
      discount: Number(line.tradeDiscount),
      effectiveCost: Number(line.effectiveCost),
      retailPrice: Number(line.retailPrice)
    }))
  };
}

/** Stock position per product, with every figure derived from the batches (which the ledger always agrees with). */
export async function inventoryReport(branchId: string, options: { now?: Date; nearExpiryDays?: number } = {}): Promise<InventoryItem[]> {
  const now = options.now ?? new Date();
  const nearExpiryDays = options.nearExpiryDays ?? NEAR_EXPIRY_DAYS;
  const products = await db.product.findMany({ where: { branchId, isActive: true }, include: { masterProduct: true, batches: { where: { quantity: { gt: 0 } }, orderBy: { expiryDate: "asc" } } }, orderBy: { name: "asc" } });
  return products.map((product) => {
    const structure = packStructure(product);
    const perPack = unitSize("pack", structure);
    const status = stockStatus(product.batches, { now, unitsPerPack: perPack, lowStockPacks: product.lowStockThreshold, nearExpiryDays });
    const horizon = now.getTime() + nearExpiryDays * DAY;
    const batchStatus = (expiry: Date): BatchStatus => expiry.getTime() <= now.getTime() ? "expired" : expiry.getTime() <= horizon ? "near-expiry" : "ok";
    return {
      productId: product.id,
      name: product.masterProduct?.name ?? product.name,
      generic: product.masterProduct?.generic ?? product.generic,
      company: product.masterProduct?.company ?? product.company,
      barcode: product.barcode,
      rackLocation: product.rackLocation,
      unitsPerPack: structure.stripsPerPack,
      tabletsPerStrip: structure.tabletsPerStrip,
      lowStockThreshold: product.lowStockThreshold,
      sellable: status.sellable,
      nearExpiry: status.nearExpiry,
      expired: status.expired,
      nearestExpiry: status.nearestExpiry?.toISOString() ?? null,
      lowStock: status.lowStock,
      valueAtCost: roundMoney(product.batches.reduce((sum, batch) => sum + batch.quantity / perPack * Number(batch.costPrice ?? 0), 0)),
      valueAtRetail: roundMoney(product.batches.reduce((sum, batch) => sum + batch.quantity / perPack * Number(batch.retailPrice), 0)),
      batches: product.batches.map((batch) => ({ id: batch.id, batchNo: batch.batchNo, expiryDate: batch.expiryDate.toISOString(), quantity: batch.quantity, retailPrice: Number(batch.retailPrice), costPrice: batch.costPrice == null ? null : Number(batch.costPrice), status: batchStatus(batch.expiryDate) }))
    };
  });
}

/** Batches whose stock differs from the sum of their ledger movements. Should always be empty. */
export async function ledgerMismatches(branchId: string): Promise<Array<{ batchId: string; batchNo: string; quantity: number; ledger: number }>> {
  const rows = await db.$queryRaw<Array<{ batchId: string; batchNo: string; quantity: number; ledger: bigint | null }>>`
    SELECT b."id" AS "batchId", b."batchNo", b."quantity", SUM(m."quantity") AS "ledger"
    FROM "Batch" b
    JOIN "Product" p ON p."id" = b."productId"
    LEFT JOIN "StockMovement" m ON m."batchId" = b."id"
    WHERE p."branchId" = ${branchId}
    GROUP BY b."id", b."batchNo", b."quantity"
    HAVING b."quantity" <> COALESCE(SUM(m."quantity"), 0)`;
  return rows.map((row) => ({ ...row, ledger: Number(row.ledger ?? 0) }));
}
