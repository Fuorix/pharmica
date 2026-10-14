import { describe, expect, it } from "vitest";
import { accessFor, addMonths, graceEndsAt, nextPeriodStart, periodPrice, renewalDue, subscriptionState } from "./subscription";

const day = 86_400_000;
const paidThrough = new Date("2026-11-01T00:00:00.000Z");
const at = (offsetDays: number) => new Date(paidThrough.getTime() + offsetDays * day);

describe("subscription state", () => {
  it("moves from active to grace to expired at exact instants", () => {
    const paid = { isTrial: false, paidThrough, cancelledAt: null };
    expect(subscriptionState(paid, new Date(paidThrough.getTime() - 1))).toBe("ACTIVE");
    expect(subscriptionState(paid, paidThrough)).toBe("GRACE");
    expect(subscriptionState(paid, new Date(graceEndsAt(paidThrough).getTime() - 1))).toBe("GRACE");
    expect(subscriptionState(paid, graceEndsAt(paidThrough))).toBe("EXPIRED");
  });

  it("calls an unpaid subscription a trial, and cancellation overrides everything", () => {
    expect(subscriptionState({ isTrial: true, paidThrough, cancelledAt: null }, at(-3))).toBe("TRIAL");
    expect(subscriptionState({ isTrial: true, paidThrough, cancelledAt: null }, at(1))).toBe("GRACE");
    expect(subscriptionState({ isTrial: false, paidThrough, cancelledAt: at(-10) }, at(-5))).toBe("CANCELLED");
    expect(subscriptionState({ isTrial: false, paidThrough, cancelledAt: at(5) }, at(-5))).toBe("ACTIVE");
  });

  it("never stops billing or export, and pauses cloud features in grace", () => {
    for (const state of ["TRIAL", "ACTIVE", "GRACE", "EXPIRED", "CANCELLED"] as const) {
      expect(accessFor(state)).toMatchObject({ billing: true, export: true, payments: true });
    }
    expect(accessFor("ACTIVE")).toMatchObject({ sync: true, reports: true, mobile: true, manage: true });
    expect(accessFor("GRACE")).toMatchObject({ sync: false, reports: false, mobile: false, manage: true });
    expect(accessFor("EXPIRED")).toMatchObject({ sync: false, reports: false, manage: false });
  });

  it("reminds a week before the paid-through date, not after", () => {
    const paid = { isTrial: false, paidThrough, cancelledAt: null };
    expect(renewalDue(paid, at(-8))).toBe(false);
    expect(renewalDue(paid, at(-7))).toBe(true);
    expect(renewalDue(paid, at(1))).toBe(false);
  });
});

describe("billing periods", () => {
  const plan = { monthlyPrice: 6000, quarterlyDiscountPercent: 5, yearlyDiscountPercent: 15 };

  it("prices longer prepaid periods with their discount", () => {
    expect(periodPrice(plan, "MONTHLY")).toEqual({ months: 1, subtotal: 6000, discount: 0, total: 6000 });
    expect(periodPrice(plan, "QUARTERLY")).toEqual({ months: 3, subtotal: 18000, discount: 900, total: 17100 });
    expect(periodPrice(plan, "YEARLY")).toEqual({ months: 12, subtotal: 72000, discount: 10800, total: 61200 });
  });

  it("adds calendar months and clamps to the end of shorter months", () => {
    expect(addMonths(new Date("2026-01-31T19:00:00.000Z"), 1).toISOString()).toBe("2026-02-28T19:00:00.000Z");
    expect(addMonths(new Date("2026-11-15T00:00:00.000Z"), 3).toISOString()).toBe("2027-02-15T00:00:00.000Z");
  });

  it("continues from the paid-through date unless the shop has expired", () => {
    const paid = { isTrial: false, paidThrough, cancelledAt: null };
    expect(nextPeriodStart(paid, at(-3))).toEqual(paidThrough);
    expect(nextPeriodStart(paid, at(10))).toEqual(paidThrough);
    expect(nextPeriodStart(paid, at(40))).toEqual(at(40));
  });
});
