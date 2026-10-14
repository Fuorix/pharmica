import { describe, expect, it } from "vitest";
import { nextScheduledPrice, resolveCurrentPrice } from "./master-price";

const now = new Date("2026-10-06T00:00:00Z");
const entry = (price: number, effective: string, recorded = effective) => ({ price, effectiveFrom: new Date(effective), createdAt: new Date(recorded) });

describe("resolveCurrentPrice", () => {
  it("uses the latest price that has already taken effect", () => {
    const history = [entry(90, "2026-01-01"), entry(100, "2026-07-01"), entry(120, "2026-12-01")];
    expect(resolveCurrentPrice(history, now)?.price).toBe(100);
    expect(nextScheduledPrice(history, now)?.price).toBe(120);
  });

  it("does not let a back-dated correction override a newer price", () => {
    const history = [entry(100, "2026-07-01", "2026-07-01"), entry(95, "2026-03-01", "2026-10-01")];
    expect(resolveCurrentPrice(history, now)?.price).toBe(100);
  });

  it("prefers the most recently recorded entry for the same effective date", () => {
    const history = [entry(100, "2026-07-01", "2026-07-01"), entry(105, "2026-07-01", "2026-07-02")];
    expect(resolveCurrentPrice(history, now)?.price).toBe(105);
  });

  it("returns nothing before any price applies", () => {
    expect(resolveCurrentPrice([entry(120, "2026-12-01")], now)).toBeNull();
  });
});
