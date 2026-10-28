import type { CatalogueProduct, MasterProductSummary } from "@pharmica/contracts";
import { describe, expect, it } from "vitest";
import { searchCatalogue, searchMasterList } from "./state";

function item(id: string, name: string, barcode: string | null): CatalogueProduct {
  return {
    id, branchId: "b1", masterProductId: null, name, brand: name, generic: null, company: "Abbott", barcode, category: "medicine",
    unitsPerPack: 1, tabletsPerStrip: 1, sellableUnits: ["pack"], officialRetailPrice: 100, retailPriceOverride: null,
    sellingPrice: 100, stockQuantity: 10, nearestExpiry: null, isPrescriptionOnly: false, isControlled: false,
    rackLocation: null, lowStockThreshold: 0, isShopSpecific: false
  };
}

describe("searchCatalogue barcode prefix", () => {
  const catalogue = [
    item("p-brufen", "Brufen 400mg", "2000000000013"),
    item("p-arinac", "Arinac", "2000000000020"),
    item("p-panadol", "Panadol 500mg", "8964000111222")
  ];

  it("finds products whose barcode starts with the query", () => {
    expect(searchCatalogue(catalogue, "200").map((product) => product.id)).toEqual(["p-arinac", "p-brufen"]);
    expect(searchCatalogue(catalogue, "8964").map((product) => product.id)).toEqual(["p-panadol"]);
  });

  it("does not match digits in the middle or end of a barcode", () => {
    expect(searchCatalogue(catalogue, "00013").map((product) => product.id)).toEqual([]);
  });

  it("still matches a full barcode and ranks it with other prefix hits", () => {
    expect(searchCatalogue(catalogue, "2000000000020").map((product) => product.id)).toEqual(["p-arinac"]);
  });
});

describe("searchMasterList barcode prefix", () => {
  const master: MasterProductSummary[] = [
    { id: "m-risek", name: "Risek 20mg", brand: "Risek", generic: "Omeprazole", company: "Getz", dosageForm: "Capsule", strength: "20mg", barcode: "2000000000099", unitsPerPack: 1, tabletsPerStrip: 14, officialRetailPrice: 350, isPrescriptionOnly: false, isControlled: false }
  ];

  it("finds a master item by barcode prefix and ignores a mid-code query", () => {
    expect(searchMasterList(master, "2000").map((product) => product.id)).toEqual(["m-risek"]);
    expect(searchMasterList(master, "0099")).toEqual([]);
  });
});
