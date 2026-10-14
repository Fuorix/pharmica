import { describe, expect, it } from "vitest";
import { allocateFefo, availableUnits } from "./fefo";

const now = new Date("2026-10-06T10:00:00Z");
const batch = (id: string, expiry: string, quantity: number) => ({ id, expiryDate: new Date(expiry), quantity });

describe("allocateFefo", () => {
  it("takes the earliest-expiring batch first", () => {
    const batches = [batch("late", "2028-01-01", 100), batch("early", "2027-01-01", 100)];
    expect(allocateFefo(batches, 3, 10, now)).toEqual([{ batchId: "early", units: 3 }]);
  });

  it("spills into the next batch when the first runs out", () => {
    const batches = [batch("late", "2028-01-01", 100), batch("early", "2027-01-01", 20)];
    expect(allocateFefo(batches, 3, 10, now)).toEqual([{ batchId: "early", units: 2 }, { batchId: "late", units: 1 }]);
  });

  it("skips expired and empty batches", () => {
    const batches = [batch("expired", "2026-09-30", 100), batch("today", "2026-10-06T00:00:00Z", 100), batch("empty", "2026-12-01", 0), batch("good", "2027-06-01", 50)];
    expect(allocateFefo(batches, 1, 10, now)).toEqual([{ batchId: "good", units: 1 }]);
  });

  it("never builds a unit from two partial batches", () => {
    const batches = [batch("a", "2027-01-01", 5), batch("b", "2027-02-01", 8)];
    expect(allocateFefo(batches, 1, 10, now)).toBeNull();
    expect(allocateFefo(batches, 13, 1, now)).toEqual([{ batchId: "a", units: 5 }, { batchId: "b", units: 8 }]);
  });

  it("returns null when stock is short", () => {
    expect(allocateFefo([batch("a", "2027-01-01", 10)], 2, 10, now)).toBeNull();
  });

  it("counts whole sellable units", () => {
    expect(availableUnits([batch("a", "2027-01-01", 25), batch("b", "2025-01-01", 100)], 10, now)).toBe(2);
  });
});
