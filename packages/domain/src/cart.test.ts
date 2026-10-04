import { describe, expect, it } from "vitest";
import { billTotals, discountWithinLimit, priceCart, refundFor, splitAmount, type PricingBatch, type PricingProduct } from "./cart";

const now = new Date("2026-10-07T10:00:00Z");
const day = 24 * 60 * 60 * 1000;
const tablets: PricingProduct = { id: "brufen", name: "Brufen 400mg", structure: { stripsPerPack: 2, tabletsPerStrip: 10 }, retailPriceOverride: null };
const syrup: PricingProduct = { id: "syrup", name: "Brufen Syrup", structure: { stripsPerPack: 1, tabletsPerStrip: 1 }, retailPriceOverride: null };
const products = new Map([tablets, syrup].map((product) => [product.id, product]));
const batch = (id: string, productId: string, packs: number, perPack: number, price: number, days: number): PricingBatch =>
  ({ id, productId, batchNo: id, quantity: packs * perPack, retailPrice: price, expiryDate: new Date(now.getTime() + days * day) });

describe("priceCart", () => {
  const batches = [batch("new", "brufen", 10, 20, 330, 500), batch("old", "brufen", 2, 20, 300, 60), batch("s1", "syrup", 3, 1, 145, 300)];

  it("prices each batch at its own retail price, earliest expiry first", () => {
    const cart = priceCart([{ key: "a", productId: "brufen", unit: "pack", quantity: 3, discount: 0 }], products, batches, now);
    expect(cart.problems).toEqual([]);
    expect(cart.lines.map((line) => [line.batchId, line.quantity, line.unitPrice, line.lineTotal])).toEqual([["old", 2, 300, 600], ["new", 1, 330, 330]]);
    expect(cart.subtotal).toBe(930);
  });

  it("keeps track of stock already used by earlier rows of the same cart", () => {
    const cart = priceCart([
      { key: "a", productId: "brufen", unit: "pack", quantity: 2, discount: 0 },
      { key: "b", productId: "brufen", unit: "strip", quantity: 1, discount: 0 }
    ], products, batches, now);
    expect(cart.lines.map((line) => [line.itemKey, line.batchId])).toEqual([["a", "old"], ["b", "new"]]);
  });

  it("spreads an item discount over its batch lines without losing a paisa", () => {
    const cart = priceCart([{ key: "a", productId: "brufen", unit: "pack", quantity: 3, discount: 100 }], products, batches, now);
    expect(cart.lines.map((line) => line.discount)).toEqual([64.51, 35.49]);
    expect(cart.itemDiscount).toBe(100);
  });

  it("reports every problem instead of stopping at the first", () => {
    const cart = priceCart([
      { key: "a", productId: "syrup", unit: "tablet", quantity: 1, discount: 0 },
      { key: "b", productId: "syrup", unit: "pack", quantity: 9, discount: 0 },
      { key: "c", productId: "brufen", unit: "pack", quantity: 0, discount: 0 },
      { key: "d", productId: "brufen", unit: "pack", quantity: 1, discount: 999 },
      { key: "e", productId: "gone", unit: "pack", quantity: 1, discount: 0 }
    ], products, batches, now);
    expect(cart.problems.map((problem) => [problem.itemKey, problem.code])).toEqual([
      ["a", "INVALID_UNIT"], ["b", "INSUFFICIENT_STOCK"], ["c", "INVALID_QUANTITY"], ["d", "DISCOUNT_TOO_LARGE"], ["e", "UNKNOWN_PRODUCT"]
    ]);
    expect(cart.problems[1].message).toBe("Brufen Syrup: only 3 packs in stock");
  });

  it("applies a shop override only when it is lower than the batch price", () => {
    const cheaper = new Map([["brufen", { ...tablets, retailPriceOverride: 310 }]]);
    const cart = priceCart([{ key: "a", productId: "brufen", unit: "pack", quantity: 3, discount: 0 }], cheaper, batches, now);
    expect(cart.lines.map((line) => line.unitPrice)).toEqual([300, 310]);
  });
});

describe("bill totals and discount limits", () => {
  it("combines item and bill discounts", () => {
    expect(billTotals({ subtotal: 1000, itemDiscount: 50 }, 25)).toEqual({ subtotal: 1000, itemDiscount: 50, billDiscount: 25, discount: 75, total: 925 });
    expect(billTotals({ subtotal: 100, itemDiscount: 50 }, 60)).toEqual({ error: "Bill discount cannot be more than PKR 50.00" });
  });

  it("enforces a cashier's percentage limit; owners have none", () => {
    expect(discountWithinLimit(1000, 50, 5)).toBe(true);
    expect(discountWithinLimit(1000, 51, 5)).toBe(false);
    expect(discountWithinLimit(1000, 1, 0)).toBe(false);
    expect(discountWithinLimit(1000, 1000, null)).toBe(true);
  });

  it("splits amounts exactly", () => {
    expect(splitAmount(10, [1, 1, 1])).toEqual([3.33, 3.33, 3.34]);
    expect(splitAmount(0.01, [5, 5])).toEqual([0, 0.01]);
  });
});

describe("refundFor", () => {
  const lines = [{ id: "l1", quantity: 2, lineTotal: 600, returned: 0 }, { id: "l2", quantity: 1, lineTotal: 300, returned: 0 }];

  it("refunds each unit's share, scaled by the bill discount", () => {
    // Sale of 900 with a 90 bill discount: every rupee of line total refunds 0.90.
    expect(refundFor(810, lines, [{ saleLineId: "l1", quantity: 1 }])).toEqual({ amount: 270, lines: [{ saleLineId: "l1", quantity: 1, amount: 270 }] });
  });

  it("refunds the whole sale when everything comes back", () => {
    expect(refundFor(810, lines, [{ saleLineId: "l1", quantity: 2 }, { saleLineId: "l2", quantity: 1 }])).toMatchObject({ amount: 810 });
  });

  it("refuses to return more than was sold or already returned", () => {
    expect(refundFor(900, [{ ...lines[0], returned: 1 }], [{ saleLineId: "l1", quantity: 2 }])).toEqual({ error: "Only 1 of that item can still be returned" });
    expect(refundFor(900, lines, [{ saleLineId: "nope", quantity: 1 }])).toEqual({ error: "A returned item is not on this sale" });
  });
});
