import type { CatalogueProduct, MasterProductSummary, ProductCategory } from "@pharmica/contracts";
import type { Prisma } from "@pharmica/database/client";
import { isSellable, packStructure, sellableUnits, sellingPackPrice } from "@pharmica/domain";

export const catalogueInclude = {
  masterProduct: true,
  batches: { where: { quantity: { gt: 0 } }, orderBy: { expiryDate: "asc" } }
} satisfies Prisma.ProductInclude;

type CatalogueRow = Prisma.ProductGetPayload<{ include: typeof catalogueInclude }>;

const toNumber = (value: Prisma.Decimal | null | undefined) => value == null ? null : Number(value);

export function toCatalogueProduct(product: CatalogueRow, now = new Date()): CatalogueProduct {
  const structure = packStructure(product);
  const sellable = product.batches.filter((batch) => isSellable(batch, now));
  const next = sellable[0];
  const override = toNumber(product.retailPriceOverride);
  const master = product.masterProduct;

  return {
    id: product.id,
    branchId: product.branchId,
    masterProductId: product.masterProductId,
    name: master?.name ?? product.name,
    brand: master?.brand ?? null,
    generic: master?.generic ?? product.generic,
    company: master?.company ?? product.company,
    barcode: product.barcode ?? master?.barcode ?? null,
    category: product.category.toLowerCase() as ProductCategory,
    unitsPerPack: structure.stripsPerPack,
    tabletsPerStrip: structure.tabletsPerStrip,
    sellableUnits: sellableUnits(structure),
    officialRetailPrice: toNumber(master?.officialRetailPrice),
    retailPriceOverride: override,
    sellingPrice: next ? sellingPackPrice(Number(next.retailPrice), override) : null,
    stockQuantity: sellable.reduce((sum, batch) => sum + batch.quantity, 0),
    nearestExpiry: next?.expiryDate.toISOString() ?? null,
    isPrescriptionOnly: master?.isPrescriptionOnly ?? false,
    isControlled: master?.isControlled ?? false,
    rackLocation: product.rackLocation,
    lowStockThreshold: product.lowStockThreshold,
    isShopSpecific: product.isShopSpecific
  };
}

export function toMasterSummary(master: Prisma.MasterProductGetPayload<object>): MasterProductSummary {
  return {
    id: master.id,
    name: master.name,
    brand: master.brand,
    generic: master.generic,
    company: master.company,
    dosageForm: master.dosageForm,
    strength: master.strength,
    barcode: master.barcode,
    unitsPerPack: master.unitsPerPack,
    tabletsPerStrip: master.tabletsPerStrip,
    officialRetailPrice: toNumber(master.officialRetailPrice),
    isPrescriptionOnly: master.isPrescriptionOnly,
    isControlled: master.isControlled
  };
}

/** Text match across the fields a cashier searches by: brand/name, generic (salt), company, and barcode. */
export function masterSearchWhere(query: string): Prisma.MasterProductWhereInput {
  const contains = { contains: query, mode: "insensitive" as const };
  return { OR: [{ name: contains }, { brand: contains }, { generic: contains }, { company: contains }, { barcode: query }] };
}

export function productSearchWhere(query: string): Prisma.ProductWhereInput {
  const contains = { contains: query, mode: "insensitive" as const };
  return {
    OR: [
      { name: contains },
      { generic: contains },
      { company: contains },
      { barcode: query },
      { masterProduct: { is: masterSearchWhere(query) } }
    ]
  };
}

/** Exact barcode hits first, then names starting with the query, then other matches, alphabetically. */
export function rankMatches<T extends { name: string; barcode: string | null }>(items: T[], query: string): T[] {
  const lower = query.toLowerCase();
  const score = (item: T) => item.barcode === query ? 0 : item.name.toLowerCase().startsWith(lower) ? 1 : 2;
  return [...items].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}
