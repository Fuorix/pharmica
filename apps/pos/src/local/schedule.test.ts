import { describe, expect, it } from "vitest";
import { MAX_SYNC_DELAY_MS, nextSyncDelay } from "./schedule";

describe("nextSyncDelay", () => {
  it("syncs at the normal pace while things work", () => {
    expect(nextSyncDelay(0, 20_000, 0.5)).toBe(20_000);
  });

  it("doubles the wait after each failure, up to five minutes", () => {
    expect(nextSyncDelay(1, 20_000, 0.5)).toBe(40_000);
    expect(nextSyncDelay(3, 20_000, 0.5)).toBe(160_000);
    expect(nextSyncDelay(10, 20_000, 0.5)).toBe(MAX_SYNC_DELAY_MS);
  });

  it("spreads counters out by up to 20% either way", () => {
    expect(nextSyncDelay(2, 20_000, 0)).toBe(64_000);
    expect(nextSyncDelay(2, 20_000, 1)).toBe(96_000);
  });
});
