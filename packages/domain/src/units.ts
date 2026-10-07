import type { SaleUnit } from "@pharmica/contracts";

/** How a product is packed. Stock is counted in base units: single tablets, or whole packs for unsplittable items. */
export interface PackStructure {
  /** Strips (or bottles, tubes) per pack. */
  stripsPerPack: number;
  /** Tablets per strip; 1 when a strip cannot be split. */
  tabletsPerStrip: number;
}

type PackSource = {
  unitsPerPack?: number | null;
  tabletsPerStrip?: number | null;
  masterProduct?: { unitsPerPack: number; tabletsPerStrip: number } | null;
};

export function packStructure(product: PackSource): PackStructure {
  return {
    stripsPerPack: product.masterProduct?.unitsPerPack ?? product.unitsPerPack ?? 1,
    tabletsPerStrip: product.masterProduct?.tabletsPerStrip ?? product.tabletsPerStrip ?? 1
  };
}

/** Base units contained in one selling unit. */
export function unitSize(unit: SaleUnit, structure: PackStructure): number {
  if (unit === "pack") return structure.stripsPerPack * structure.tabletsPerStrip;
  if (unit === "strip") return structure.tabletsPerStrip;
  return 1;
}

/** Units a product can be sold in: strips only if a pack holds more than one, tablets only if a strip can be split. */
export function sellableUnits(structure: PackStructure): SaleUnit[] {
  const units: SaleUnit[] = ["pack"];
  if (structure.stripsPerPack > 1) units.push("strip");
  if (structure.tabletsPerStrip > 1) units.push("tablet");
  return units;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Price of one selling unit, derived from the pack price. */
export function unitPrice(packPrice: number, unit: SaleUnit, structure: PackStructure): number {
  return roundMoney(packPrice * unitSize(unit, structure) / unitSize("pack", structure));
}

/** The shop's selling price for a batch: the batch's printed retail price, lowered (never raised) by a shop override. */
export function sellingPackPrice(batchRetailPrice: number, override: number | null | undefined): number {
  return override == null ? batchRetailPrice : Math.min(batchRetailPrice, override);
}

/** Cost of one selling unit from the batch's cost per pack, kept to four decimals so tablet costs stay exact enough. */
export function unitCost(packCost: number | null, unit: SaleUnit, structure: PackStructure): number | null {
  if (packCost == null) return null;
  return Math.round(packCost * unitSize(unit, structure) / unitSize("pack", structure) * 10_000) / 10_000;
}
