import { splitAmount } from "./cart";
import { isSellable, type StockBatch } from "./fefo";
import { roundMoney } from "./units";

export interface PurchaseLineInput {
  /** Packs paid for. */
  quantity: number;
  /** Free packs from the distributor ("bonus"). */
  bonusQuantity: number;
  /** Invoice price per pack before discounts. */
  costPrice: number;
  /** Trade discount on this line, in PKR. */
  discount: number;
}

export interface PricedPurchaseLine {
  gross: number;
  discount: number;
  /** Share of the invoice-level discount. */
  invoiceDiscount: number;
  net: number;
  /** What one pack really cost after discounts, spread over paid and bonus packs. Used for profit. */
  effectiveCost: number;
}

export interface PurchaseTotals {
  lines: PricedPurchaseLine[];
  subtotal: number;
  lineDiscount: number;
  invoiceDiscount: number;
  total: number;
  paidPacks: number;
  bonusPacks: number;
}

/** Totals a supplier invoice, with bonus packs and trade discounts visible separately. */
export function purchaseTotals(lines: PurchaseLineInput[], invoiceDiscount: number): PurchaseTotals | { error: string } {
  const priced: PricedPurchaseLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (!Number.isInteger(line.quantity) || line.quantity < 0 || !Number.isInteger(line.bonusQuantity) || line.bonusQuantity < 0) return { error: `Line ${index + 1}: quantities must be whole numbers` };
    if (line.quantity + line.bonusQuantity === 0) return { error: `Line ${index + 1}: enter a quantity` };
    if (line.costPrice < 0 || line.discount < 0) return { error: `Line ${index + 1}: prices and discounts cannot be negative` };
    const gross = roundMoney(line.quantity * line.costPrice);
    if (line.discount > gross) return { error: `Line ${index + 1}: discount is more than the line` };
    priced.push({ gross, discount: roundMoney(line.discount), invoiceDiscount: 0, net: roundMoney(gross - line.discount), effectiveCost: 0 });
  }
  const afterLines = roundMoney(priced.reduce((sum, line) => sum + line.net, 0));
  if (invoiceDiscount < 0 || invoiceDiscount > afterLines + 0.005) return { error: `Invoice discount cannot be more than PKR ${afterLines.toFixed(2)}` };

  splitAmount(invoiceDiscount, priced.map((line) => line.net)).forEach((share, index) => {
    const line = priced[index];
    line.invoiceDiscount = share;
    line.net = roundMoney(line.net - share);
    const packs = lines[index].quantity + lines[index].bonusQuantity;
    line.effectiveCost = roundMoney(line.net / packs);
  });

  return {
    lines: priced,
    subtotal: roundMoney(priced.reduce((sum, line) => sum + line.gross, 0)),
    lineDiscount: roundMoney(priced.reduce((sum, line) => sum + line.discount, 0)),
    invoiceDiscount: roundMoney(invoiceDiscount),
    total: roundMoney(priced.reduce((sum, line) => sum + line.net, 0)),
    paidPacks: lines.reduce((sum, line) => sum + line.quantity, 0),
    bonusPacks: lines.reduce((sum, line) => sum + line.bonusQuantity, 0)
  };
}

/** Weighted average cost per pack when more stock arrives for a batch already on the shelf. */
export function averageCost(current: { quantity: number; cost: number | null }, incoming: { quantity: number; cost: number }): number {
  if (current.cost == null || current.quantity <= 0) return incoming.cost;
  return roundMoney((current.quantity * current.cost + incoming.quantity * incoming.cost) / (current.quantity + incoming.quantity));
}

export const NEAR_EXPIRY_DAYS = 90;

export interface StockStatus {
  /** Base units that can be sold (not expired). */
  sellable: number;
  /** Base units in batches that expire within the near-expiry window. */
  nearExpiry: number;
  /** Base units already expired and waiting to be written off or returned. */
  expired: number;
  nearestExpiry: Date | null;
  lowStock: boolean;
}

/**
 * Stock position for one product. Low stock compares sellable stock with the owner's alert level in packs;
 * near expiry means a batch with stock expires within `nearExpiryDays`.
 */
export function stockStatus(batches: StockBatch[], options: { now: Date; unitsPerPack: number; lowStockPacks: number; nearExpiryDays?: number }): StockStatus {
  const horizon = options.now.getTime() + (options.nearExpiryDays ?? NEAR_EXPIRY_DAYS) * 86_400_000;
  const withStock = batches.filter((batch) => batch.quantity > 0);
  const sellable = withStock.filter((batch) => isSellable(batch, options.now));
  const sellableUnits = sellable.reduce((sum, batch) => sum + batch.quantity, 0);
  const nearest = sellable.reduce<Date | null>((soonest, batch) => !soonest || batch.expiryDate < soonest ? batch.expiryDate : soonest, null);
  return {
    sellable: sellableUnits,
    nearExpiry: sellable.filter((batch) => batch.expiryDate.getTime() <= horizon).reduce((sum, batch) => sum + batch.quantity, 0),
    expired: withStock.filter((batch) => !isSellable(batch, options.now)).reduce((sum, batch) => sum + batch.quantity, 0),
    nearestExpiry: nearest,
    lowStock: options.lowStockPacks > 0 && sellableUnits < options.lowStockPacks * options.unitsPerPack
  };
}
