import { describe, expect, it } from "vitest";
import { formatReceiptNo, ledgerBalance } from "./ledger";
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
      countedCash: 5820
    });
    expect(report).toMatchObject({ salesCount: 3, voidCount: 1, returnCount: 1, netSales: 1680, discounts: 50, expectedCash: 5830, variance: -10 });
    expect(report.byMethod).toEqual({ cash: 930, card: 450, credit: 300 });
  });
});

describe("ledger", () => {
  it("subtracts payments and returned credit from what a customer owes", () => {
    expect(ledgerBalance([{ type: "CREDIT_SALE", amount: 500.1 }, { type: "PAYMENT", amount: 200 }, { type: "CREDIT_RETURN", amount: 0.1 }, { type: "ADJUSTMENT", amount: 5 }])).toBe(305);
  });

  it("formats per-device receipt numbers", () => {
    expect(formatReceiptNo("cmuvjfpzm0007uo1gk9dp2bfj", 42)).toBe("2BFJ-000042");
  });
});
