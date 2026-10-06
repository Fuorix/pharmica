import { describe, expect, it } from "vitest";
import { averageCost, purchaseTotals, stockStatus } from "./inventory";

describe("purchaseTotals", () => {
  it("shows bonus packs and both kinds of trade discount, and the real cost per pack", () => {
    const totals = purchaseTotals([
      { quantity: 10, bonusQuantity: 2, costPrice: 200, discount: 100 },
      { quantity: 5, bonusQuantity: 0, costPrice: 100, discount: 0 }
    ], 96);
    if ("error" in totals) throw new Error(totals.error);
    expect(totals).toMatchObject({ subtotal: 2500, lineDiscount: 100, invoiceDiscount: 96, total: 2304, paidPacks: 15, bonusPacks: 2 });
    // Line 1: 2000 - 100 = 1900, minus its 76.00 share of the invoice discount = 1824, over 12 packs = 152.
    expect(totals.lines[0]).toMatchObject({ net: 1824, effectiveCost: 152 });
    // Line 2: 500 minus its 20.00 share = 480, over 5 packs = 96.
    expect(totals.lines[1]).toMatchObject({ net: 480, effectiveCost: 96 });
  });

  it("accepts an all-bonus line and rejects impossible input", () => {
    expect(purchaseTotals([{ quantity: 0, bonusQuantity: 3, costPrice: 50, discount: 0 }], 0)).toMatchObject({ total: 0, bonusPacks: 3 });
    expect(purchaseTotals([{ quantity: 1, bonusQuantity: 0, costPrice: 50, discount: 60 }], 0)).toEqual({ error: "Line 1: discount is more than the line" });
    expect(purchaseTotals([{ quantity: 1, bonusQuantity: 0, costPrice: 50, discount: 0 }], 60)).toEqual({ error: "Invoice discount cannot be more than PKR 50.00" });
    expect(purchaseTotals([{ quantity: 0, bonusQuantity: 0, costPrice: 50, discount: 0 }], 0)).toEqual({ error: "Line 1: enter a quantity" });
  });

  it("averages cost when more stock arrives for a batch on the shelf", () => {
    expect(averageCost({ quantity: 10, cost: 100 }, { quantity: 30, cost: 120 })).toBe(115);
    expect(averageCost({ quantity: 0, cost: 100 }, { quantity: 5, cost: 80 })).toBe(80);
  });
});

describe("stockStatus", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  const batch = (id: string, quantity: number, days: number) => ({ id, quantity, expiryDate: new Date(now.getTime() + days * 86_400_000) });

  it("separates sellable, near-expiry, and expired stock", () => {
    const status = stockStatus([batch("a", 20, 30), batch("b", 100, 400), batch("c", 15, -3), batch("d", 0, 10)], { now, unitsPerPack: 20, lowStockPacks: 2 });
    expect(status).toMatchObject({ sellable: 120, nearExpiry: 20, expired: 15, lowStock: false });
    expect(status.nearestExpiry?.toISOString()).toBe(batch("a", 0, 30).expiryDate.toISOString());
  });

  it("flags low stock below the alert level in packs, but never without one", () => {
    expect(stockStatus([batch("a", 39, 300)], { now, unitsPerPack: 20, lowStockPacks: 2 }).lowStock).toBe(true);
    expect(stockStatus([batch("a", 40, 300)], { now, unitsPerPack: 20, lowStockPacks: 2 }).lowStock).toBe(false);
    expect(stockStatus([], { now, unitsPerPack: 20, lowStockPacks: 0 }).lowStock).toBe(false);
  });
});
