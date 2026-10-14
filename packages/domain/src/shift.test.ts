import { describe, expect, it } from "vitest";
import { ageLedger, formatReceiptNo, ledgerBalance, withinCreditLimit } from "./ledger";
import { computeShiftReport } from "./shift";

describe("computeShiftReport", () => {
  it("works out expected cash and the variance against the counted cash", () => {
    const report = computeShiftReport({
      openingCash: 5000,
      sales: [
        { total: 930, discount: 0, paymentMethod: "cash", voided: false },
        { total: 450, discount: 50, paymentMethod: "card", voided: false },
        { total: 300, discount: 0, paymentMethod: "credit", voided: false },
        { total: 200, discount: 0, paymentMethod: "cash", voided: true }
      ],
      refunds: [{ amount: 100, method: "cash" }],
      collections: [{ amount: 250, method: "cash" }, { amount: 50, method: "card" }],
      countedCash: 6070
    });
    expect(report).toMatchObject({ salesCount: 3, voidCount: 1, returnCount: 1, netSales: 1680, discounts: 50, expectedCash: 6080, variance: -10 });
    expect(report.collections).toEqual({ cash: 250, card: 50, credit: 0 });
    expect(report.byMethod).toEqual({ cash: 930, card: 450, credit: 300 });
  });
});

describe("ledger", () => {
  it("subtracts payments and returned credit from what a customer owes", () => {
    expect(ledgerBalance([{ type: "CREDIT_SALE", amount: 500.1 }, { type: "PAYMENT", amount: 200 }, { type: "CREDIT_RETURN", amount: 0.1 }, { type: "ADJUSTMENT", amount: 5 }])).toBe(305);
  });

  it("ages what is owed, paying off the oldest charges first", () => {
    const now = new Date("2026-10-12T00:00:00Z");
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const aged = ageLedger([
      { type: "CREDIT_SALE", amount: 1000, createdAt: daysAgo(100) },
      { type: "CREDIT_SALE", amount: 500, createdAt: daysAgo(45) },
      { type: "PAYMENT", amount: 800, createdAt: daysAgo(40) },
      { type: "CREDIT_SALE", amount: 300, createdAt: daysAgo(5) },
      { type: "ADJUSTMENT", amount: -100, createdAt: daysAgo(2) }
    ], now);
    // 900 of payments and credits clear the 100-day-old 1000 down to 100.
    expect(aged).toMatchObject({ balance: 900, daysOutstanding: 100, buckets: { over90: 100, days31to60: 500, current: 300, days61to90: 0 } });
    expect(ageLedger([{ type: "CREDIT_SALE", amount: 100, createdAt: daysAgo(10) }, { type: "PAYMENT", amount: 100, createdAt: daysAgo(1) }], now)).toMatchObject({ balance: 0, oldestUnpaidAt: null, daysOutstanding: 0 });
  });

  it("treats a credit limit of 0 as no credit and null as no limit", () => {
    expect(withinCreditLimit(1, 0)).toBe(false);
    expect(withinCreditLimit(0, 0)).toBe(true);
    expect(withinCreditLimit(5000, 5000)).toBe(true);
    expect(withinCreditLimit(5000.01, 5000)).toBe(false);
    expect(withinCreditLimit(1_000_000, null)).toBe(true);
  });

  it("formats per-device receipt numbers", () => {
    expect(formatReceiptNo("cmuvjfpzm0007uo1gk9dp2bfj", 42)).toBe("2BFJ-000042");
  });
});
