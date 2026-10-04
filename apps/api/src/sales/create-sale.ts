import type { SaleUnit } from "@pharmica/contracts";
import type { Prisma } from "@pharmica/database/client";
import { allocateFefo, availableUnits, packStructure, roundMoney, sellableUnits, sellingPackPrice, unitPrice, unitSize } from "@pharmica/domain";

export interface SaleLineInput {
  productId: string;
  quantity: number;
  unit: SaleUnit;
  /** A cashier-entered price per unit. It may not exceed the retail price of any batch it is sold from. */
  unitPrice?: number;
}

export class SaleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const unitMap = { pack: "PACK", strip: "STRIP", tablet: "TABLET" } as const;

type PreparedLine = { productId: string; batchId: string; quantity: number; unit: "PACK" | "STRIP" | "TABLET"; unitPrice: number; lineTotal: number; baseUnits: number };

/**
 * Turns requested lines into priced, batch-specific sale lines and takes the stock, inside `transaction`.
 * Stock is taken earliest-expiry first; each batch sells at its own retail price (after any shop override),
 * so one requested line can become several sale lines when it spans batches.
 */
export async function takeStockForSale(
  transaction: Prisma.TransactionClient,
  input: { branchId: string; userId: string; lines: SaleLineInput[]; now?: Date }
): Promise<PreparedLine[]> {
  const now = input.now ?? new Date();
  const products = await transaction.product.findMany({
    where: { id: { in: input.lines.map((line) => line.productId) }, branchId: input.branchId, isActive: true },
    include: { masterProduct: true, batches: true }
  });
  const productMap = new Map(products.map((product) => [product.id, product]));
  const prepared: PreparedLine[] = [];
  // Stock already promised to earlier lines of this sale (for the same product listed twice).
  const promised = new Map<string, number>();

  for (const line of input.lines) {
    const product = productMap.get(line.productId);
    if (!product) throw new SaleError(400, "PRODUCT_NOT_FOUND", "One or more products are unavailable in this branch");
    const structure = packStructure(product);
    if (!sellableUnits(structure).includes(line.unit)) throw new SaleError(400, "INVALID_UNIT", `${product.name} cannot be sold by the ${line.unit}`);

    const size = unitSize(line.unit, structure);
    const batches = product.batches.map((batch) => ({ ...batch, quantity: batch.quantity - (promised.get(batch.id) ?? 0) }));
    const allocations = allocateFefo(batches, line.quantity, size, now);
    if (!allocations) {
      const available = availableUnits(batches, size, now);
      throw new SaleError(409, "INSUFFICIENT_STOCK", `${product.name}: only ${available} ${line.unit}${available === 1 ? "" : "s"} in stock`);
    }

    for (const allocation of allocations) {
      const batch = product.batches.find((candidate) => candidate.id === allocation.batchId)!;
      const ceiling = unitPrice(sellingPackPrice(Number(batch.retailPrice), product.retailPriceOverride == null ? null : Number(product.retailPriceOverride)), line.unit, structure);
      if (line.unitPrice !== undefined && line.unitPrice > ceiling + 0.005) {
        throw new SaleError(400, "ABOVE_RETAIL_PRICE", `${product.name} cannot be sold above PKR ${ceiling.toFixed(2)} per ${line.unit} (batch ${batch.batchNo})`);
      }
      const price = roundMoney(line.unitPrice ?? ceiling);
      const baseUnits = allocation.units * size;
      promised.set(batch.id, (promised.get(batch.id) ?? 0) + baseUnits);
      prepared.push({ productId: product.id, batchId: batch.id, quantity: allocation.units, unit: unitMap[line.unit], unitPrice: price, lineTotal: roundMoney(allocation.units * price), baseUnits });
    }
  }

  for (const line of prepared) {
    // Guarded decrement: a concurrent sale that took this stock first makes the update match nothing.
    const updated = await transaction.batch.updateMany({ where: { id: line.batchId, quantity: { gte: line.baseUnits } }, data: { quantity: { decrement: line.baseUnits } } });
    if (updated.count !== 1) throw new SaleError(409, "INSUFFICIENT_STOCK", "Stock changed while the sale was being saved. Please try again");
  }
  return prepared;
}

/** Records the stock movements of a saved sale. */
export async function recordSaleMovements(transaction: Prisma.TransactionClient, input: { branchId: string; userId: string; saleId: string; lines: PreparedLine[] }) {
  await transaction.stockMovement.createMany({
    data: input.lines.map((line) => ({ branchId: input.branchId, productId: line.productId, batchId: line.batchId, userId: input.userId, type: "SALE" as const, quantity: -line.baseUnits, reason: "Sale", referenceId: input.saleId }))
  });
}

export function toSaleLineRows(lines: PreparedLine[]) {
  return lines.map(({ baseUnits: _baseUnits, ...line }) => line);
}
