import { describe, expect, it } from "vitest";
import { packStructure, sellableUnits, sellingPackPrice, unitCost, unitPrice, unitSize } from "./units";

const tablets = { stripsPerPack: 2, tabletsPerStrip: 10 };
const syrup = { stripsPerPack: 1, tabletsPerStrip: 1 };

describe("pack structure", () => {
  it("prefers the master product's structure over the shop item's", () => {
    expect(packStructure({ unitsPerPack: 5, tabletsPerStrip: 5, masterProduct: { unitsPerPack: 2, tabletsPerStrip: 10 } })).toEqual(tablets);
    expect(packStructure({ unitsPerPack: 3, tabletsPerStrip: null })).toEqual({ stripsPerPack: 3, tabletsPerStrip: 1 });
    expect(packStructure({})).toEqual(syrup);
  });

  it("converts selling units to base units", () => {
    expect(unitSize("pack", tablets)).toBe(20);
    expect(unitSize("strip", tablets)).toBe(10);
    expect(unitSize("tablet", tablets)).toBe(1);
  });

  it("only offers units the product can be split into", () => {
    expect(sellableUnits(tablets)).toEqual(["pack", "strip", "tablet"]);
    expect(sellableUnits(syrup)).toEqual(["pack"]);
    expect(sellableUnits({ stripsPerPack: 1, tabletsPerStrip: 10 })).toEqual(["pack", "tablet"]);
  });
});

describe("prices", () => {
  it("derives strip and tablet prices from the pack price", () => {
    expect(unitPrice(200, "pack", tablets)).toBe(200);
    expect(unitPrice(200, "strip", tablets)).toBe(100);
    expect(unitPrice(200, "tablet", tablets)).toBe(10);
    expect(unitPrice(100, "tablet", { stripsPerPack: 3, tabletsPerStrip: 10 })).toBe(3.33);
  });

  it("splits the pack cost down to strips and tablets", () => {
    expect(unitCost(152, "pack", tablets)).toBe(152);
    expect(unitCost(152, "strip", tablets)).toBe(76);
    expect(unitCost(100, "tablet", { stripsPerPack: 3, tabletsPerStrip: 10 })).toBe(3.3333);
    expect(unitCost(null, "pack", tablets)).toBeNull();
  });

  it("lets a shop override lower the batch price but never raise it", () => {
    expect(sellingPackPrice(100, null)).toBe(100);
    expect(sellingPackPrice(100, 90)).toBe(90);
    expect(sellingPackPrice(100, 120)).toBe(100);
  });
});
