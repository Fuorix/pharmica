import type { SaleUnit } from "@pharmica/contracts";
import { allocateFefo, availableUnits, type StockBatch } from "./fefo";
import { roundMoney, sellableUnits, sellingPackPrice, unitPrice, unitSize, type PackStructure } from "./units";

export interface PricingProduct {
  id: string;
  name: string;
  structure: PackStructure;
  /** Shop price per pack; it can only lower a batch's printed price. */
  retailPriceOverride: number | null;
}

export interface PricingBatch extends StockBatch {
  productId: string;
  batchNo: string;
  /** Printed retail price per pack: the legal ceiling for this batch. */
  retailPrice: number;
}

export interface CartItem {
  /** Stable id of the cart row, so problems and discounts can be tied back to it. */
  key: string;
  productId: string;
  unit: SaleUnit;
  quantity: number;
  /** Discount on this item in PKR. */
  discount: number;
}

export interface PricedLine {
  itemKey: string;
  productId: string;
  batchId: string;
  batchNo: string;
  unit: SaleUnit;
  quantity: number;
  unitPrice: number;
  /** quantity x unitPrice, before discount. */
  gross: number;
  discount: number;
  lineTotal: number;
  /** Stock taken from the batch in base units. */
  baseUnits: number;
}

export type CartProblemCode = "UNKNOWN_PRODUCT" | "INVALID_QUANTITY" | "INVALID_UNIT" | "INSUFFICIENT_STOCK" | "DISCOUNT_TOO_LARGE";
export interface CartProblem {
  itemKey: string;
  code: CartProblemCode;
  message: string;
}

export interface PricedCart {
  lines: PricedLine[];
  problems: CartProblem[];
  /** Sum of line gross amounts. */
  subtotal: number;
  /** Sum of item discounts. */
  itemDiscount: number;
}

/** Splits an amount over weights in proportion, in paisa, so the parts always add back up exactly. */
export function splitAmount(amount: number, weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const paisa = Math.round(amount * 100);
  if (total === 0) return weights.map((_, index) => (index === weights.length - 1 ? paisa / 100 : 0));
  let assigned = 0;
  return weights.map((weight, index) => {
    const share = index === weights.length - 1 ? paisa - assigned : Math.floor(paisa * weight / total);
    assigned += share;
    return share / 100;
  });
}

/**
 * Prices a cart against the stock the counter can see. Each item is taken earliest-expiry first and sells at
 * its batch's price (after any shop override), so one item can become several lines. Problems are reported
 * per item instead of thrown, so the cashier sees all of them at once.
 */
export function priceCart(items: CartItem[], products: Map<string, PricingProduct>, batches: PricingBatch[], now: Date): PricedCart {
  const lines: PricedLine[] = [];
  const problems: CartProblem[] = [];
  const promised = new Map<string, number>();
  const batchesByProduct = new Map<string, PricingBatch[]>();
  for (const batch of batches) batchesByProduct.set(batch.productId, [...(batchesByProduct.get(batch.productId) ?? []), batch]);

  for (const item of items) {
    const product = products.get(item.productId);
    if (!product) { problems.push({ itemKey: item.key, code: "UNKNOWN_PRODUCT", message: "This item is no longer in the catalogue" }); continue; }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) { problems.push({ itemKey: item.key, code: "INVALID_QUANTITY", message: `${product.name}: quantity must be a whole number above zero` }); continue; }
    if (!sellableUnits(product.structure).includes(item.unit)) { problems.push({ itemKey: item.key, code: "INVALID_UNIT", message: `${product.name} cannot be sold by the ${item.unit}` }); continue; }

    const size = unitSize(item.unit, product.structure);
    const productBatches = (batchesByProduct.get(product.id) ?? []).map((batch) => ({ ...batch, quantity: batch.quantity - (promised.get(batch.id) ?? 0) }));
    const allocations = allocateFefo(productBatches, item.quantity, size, now);
    if (!allocations) {
      const available = availableUnits(productBatches, size, now);
      problems.push({ itemKey: item.key, code: "INSUFFICIENT_STOCK", message: `${product.name}: only ${available} ${item.unit}${available === 1 ? "" : "s"} in stock` });
      continue;
    }

    const itemLines = allocations.map((allocation) => {
      const batch = productBatches.find((candidate) => candidate.id === allocation.batchId)!;
      const price = unitPrice(sellingPackPrice(batch.retailPrice, product.retailPriceOverride), item.unit, product.structure);
      const gross = roundMoney(allocation.units * price);
      return { itemKey: item.key, productId: product.id, batchId: batch.id, batchNo: batch.batchNo, unit: item.unit, quantity: allocation.units, unitPrice: price, gross, discount: 0, lineTotal: gross, baseUnits: allocation.units * size };
    });

    const itemGross = roundMoney(itemLines.reduce((sum, line) => sum + line.gross, 0));
    const discount = roundMoney(item.discount || 0);
    if (discount < 0 || discount > itemGross) {
      problems.push({ itemKey: item.key, code: "DISCOUNT_TOO_LARGE", message: `${product.name}: discount cannot be more than PKR ${itemGross.toFixed(2)}` });
      continue;
    }
    splitAmount(discount, itemLines.map((line) => line.gross)).forEach((share, index) => {
      itemLines[index].discount = share;
      itemLines[index].lineTotal = roundMoney(itemLines[index].gross - share);
    });
    for (const line of itemLines) promised.set(line.batchId, (promised.get(line.batchId) ?? 0) + line.baseUnits);
    lines.push(...itemLines);
  }

  return {
    lines,
    problems,
    subtotal: roundMoney(lines.reduce((sum, line) => sum + line.gross, 0)),
    itemDiscount: roundMoney(lines.reduce((sum, line) => sum + line.discount, 0))
  };
}

export interface BillTotals {
  subtotal: number;
  itemDiscount: number;
  billDiscount: number;
  /** Item and bill discounts together. */
  discount: number;
  total: number;
}

export function billTotals(cart: Pick<PricedCart, "subtotal" | "itemDiscount">, billDiscount: number): BillTotals | { error: string } {
  const afterItems = roundMoney(cart.subtotal - cart.itemDiscount);
  const bill = roundMoney(billDiscount || 0);
  if (bill < 0 || bill > afterItems) return { error: `Bill discount cannot be more than PKR ${afterItems.toFixed(2)}` };
  const discount = roundMoney(cart.itemDiscount + bill);
  return { subtotal: cart.subtotal, itemDiscount: cart.itemDiscount, billDiscount: bill, discount, total: roundMoney(cart.subtotal - discount) };
}

/** Discount as a percentage of the subtotal; owners have no limit (`maxPercent` null). */
export function discountWithinLimit(subtotal: number, discount: number, maxPercent: number | null): boolean {
  if (maxPercent == null || discount <= 0) return true;
  if (subtotal <= 0) return false;
  return discount / subtotal * 100 <= maxPercent + 1e-9;
}

export interface ReturnableLine {
  id: string;
  quantity: number;
  /** Line total after its item discount. */
  lineTotal: number;
  /** Units of this line already returned earlier. */
  returned: number;
}

/**
 * Works out a refund. Each returned unit gives back its share of the line total, scaled by the bill discount
 * (sale total / sum of line totals), so a customer never gets back more than they paid.
 */
export function refundFor(saleTotal: number, lines: ReturnableLine[], returning: Array<{ saleLineId: string; quantity: number }>):
  { amount: number; lines: Array<{ saleLineId: string; quantity: number; amount: number }> } | { error: string } {
  const sumOfLines = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const factor = sumOfLines > 0 ? saleTotal / sumOfLines : 0;
  const result: Array<{ saleLineId: string; quantity: number; amount: number }> = [];
  for (const item of returning) {
    const line = lines.find((candidate) => candidate.id === item.saleLineId);
    if (!line) return { error: "A returned item is not on this sale" };
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) return { error: "Return quantities must be whole numbers above zero" };
    if (item.quantity > line.quantity - line.returned) return { error: `Only ${line.quantity - line.returned} of that item can still be returned` };
    result.push({ saleLineId: line.id, quantity: item.quantity, amount: roundMoney(line.lineTotal * item.quantity / line.quantity * factor) });
  }
  return { amount: roundMoney(result.reduce((sum, line) => sum + line.amount, 0)), lines: result };
}
