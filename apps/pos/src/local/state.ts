import type { CatalogueProduct, MasterProductSummary, PosCustomer, PosSnapshot } from "@pharmica/contracts";
import { isSellable, roundMoney, sellingPackPrice, type PricingBatch, type PricingProduct } from "@pharmica/domain";
import type { QueuedOperation } from "./types";

export interface WorkingStock {
  batches: PricingBatch[];
  products: Map<string, PricingProduct>;
  catalogue: CatalogueProduct[];
  customers: PosCustomer[];
}

/**
 * Applies everything the server has not confirmed (pending and failed operations) on top of the last snapshot.
 * Failed operations still count: the goods really left the counter even if the server could not record them.
 */
export function workingStock(snapshot: PosSnapshot, outbox: QueuedOperation[], localCustomers: PosCustomer[], now = new Date()): WorkingStock {
  const stockDelta = new Map<string, number>();
  const balanceDelta = new Map<string, number>();
  const known = new Set(snapshot.batches.map((batch) => batch.id));
  const knownProducts = new Set(snapshot.products.map((product) => product.id));
  const receivedBatches = outbox.flatMap((queued) => queued.newBatches ?? []).filter((batch) => !known.has(batch.id));
  const receivedProducts = outbox.flatMap((queued) => queued.newProducts ?? []).filter((product) => !knownProducts.has(product.id));
  const productChanges = new Map<string, { rackLocation?: string | null; lowStockThreshold?: number }>();
  for (const change of outbox.flatMap((queued) => queued.productChanges ?? [])) productChanges.set(change.productId, { ...productChanges.get(change.productId), ...change });
  for (const queued of outbox) {
    for (const effect of queued.stockEffects) stockDelta.set(effect.batchId, (stockDelta.get(effect.batchId) ?? 0) + effect.delta);
    for (const effect of queued.balanceEffects) balanceDelta.set(effect.customerId, (balanceDelta.get(effect.customerId) ?? 0) + effect.delta);
  }

  const batches: PricingBatch[] = [...snapshot.batches, ...receivedBatches].map((batch) => ({
    id: batch.id,
    productId: batch.productId,
    batchNo: batch.batchNo,
    retailPrice: batch.retailPrice,
    expiryDate: new Date(batch.expiryDate),
    quantity: Math.max(0, batch.quantity + (stockDelta.get(batch.id) ?? 0))
  }));

  const byProduct = new Map<string, PricingBatch[]>();
  for (const batch of batches) byProduct.set(batch.productId, [...(byProduct.get(batch.productId) ?? []), batch]);

  const allProducts = [...snapshot.products, ...receivedProducts].map((product) => {
    const change = productChanges.get(product.id);
    return change ? { ...product, ...(change.rackLocation !== undefined ? { rackLocation: change.rackLocation } : {}), ...(change.lowStockThreshold !== undefined ? { lowStockThreshold: change.lowStockThreshold } : {}) } : product;
  });

  const catalogue = allProducts.map((product) => {
    const sellable = (byProduct.get(product.id) ?? []).filter((batch) => isSellable(batch, now)).sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime());
    return {
      ...product,
      stockQuantity: sellable.reduce((sum, batch) => sum + batch.quantity, 0),
      sellingPrice: sellable[0] ? sellingPackPrice(sellable[0].retailPrice, product.retailPriceOverride) : null,
      nearestExpiry: sellable[0]?.expiryDate.toISOString() ?? null
    };
  });

  const products = new Map(allProducts.map((product) => [product.id, {
    id: product.id,
    name: product.name,
    structure: { stripsPerPack: product.unitsPerPack, tabletsPerStrip: product.tabletsPerStrip },
    retailPriceOverride: product.retailPriceOverride
  }]));

  const knownCustomers = new Set(snapshot.customers.map((customer) => customer.id));
  const customers = [...snapshot.customers, ...localCustomers.filter((customer) => !knownCustomers.has(customer.id))]
    .map((customer) => ({ ...customer, balance: roundMoney(customer.balance + (balanceDelta.get(customer.id) ?? 0)) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { batches, products, catalogue, customers };
}

/** Products with the same generic (salt) that are in stock, best stocked first: offered when an item is out. */
export function substitutesFor(product: CatalogueProduct, catalogue: CatalogueProduct[]): CatalogueProduct[] {
  const generic = product.generic?.trim().toLowerCase();
  if (!generic) return [];
  return catalogue
    .filter((candidate) => candidate.id !== product.id && candidate.generic?.trim().toLowerCase() === generic && candidate.sellingPrice != null)
    .sort((a, b) => b.stockQuantity - a.stockQuantity);
}

/** Case-insensitive search across name, generic (salt), company, and barcode prefix; barcode hits come first. */
export function searchCatalogue(catalogue: CatalogueProduct[], query: string, limit = 30): CatalogueProduct[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const score = (product: CatalogueProduct) => {
    if (product.barcode?.toLowerCase().startsWith(text)) return 0;
    const name = product.name.toLowerCase();
    if (name.startsWith(text)) return 1;
    if (name.includes(text) || product.brand?.toLowerCase().includes(text)) return 2;
    if (product.generic?.toLowerCase().includes(text)) return 3;
    if (product.company?.toLowerCase().includes(text)) return 4;
    return null;
  };
  return catalogue
    .map((product) => ({ product, rank: score(product) }))
    .filter((entry): entry is { product: CatalogueProduct; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.product.name.localeCompare(b.product.name))
    .slice(0, limit)
    .map((entry) => entry.product);
}


/** Searches the master list stored on the counter the same way as the catalogue: barcode prefix first, then names. */
export function searchMasterList(master: MasterProductSummary[], query: string, limit = 20): MasterProductSummary[] {
  const text = query.trim().toLowerCase();
  if (text.length < 2) return [];
  const score = (product: MasterProductSummary) => {
    if (product.barcode?.toLowerCase().startsWith(text)) return 0;
    const name = product.name.toLowerCase();
    if (name.startsWith(text)) return 1;
    if (name.includes(text) || product.brand?.toLowerCase().includes(text)) return 2;
    if (product.generic?.toLowerCase().includes(text)) return 3;
    if (product.company?.toLowerCase().includes(text)) return 4;
    return null;
  };
  return master
    .map((product) => ({ product, rank: score(product) }))
    .filter((entry): entry is { product: MasterProductSummary; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.product.name.localeCompare(b.product.name))
    .slice(0, limit)
    .map((entry) => entry.product);
}
