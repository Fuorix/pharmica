export interface StockBatch {
  id: string;
  expiryDate: Date;
  /** Base units on hand. */
  quantity: number;
}

export interface Allocation {
  batchId: string;
  /** Whole selling units taken from this batch. */
  units: number;
}

/** True while a batch can still be sold. A batch expiring today is no longer sellable. */
export function isSellable(batch: StockBatch, now: Date): boolean {
  return batch.quantity > 0 && batch.expiryDate.getTime() > now.getTime();
}

/**
 * Picks stock earliest-expiry-first (FEFO). Each selling unit comes whole from one batch, since a
 * pack or strip cannot be assembled from two partial ones. Returns null when there is not enough stock.
 */
export function allocateFefo(batches: StockBatch[], units: number, size: number, now: Date): Allocation[] | null {
  const allocations: Allocation[] = [];
  let remaining = units;
  const ordered = batches
    .filter((batch) => isSellable(batch, now))
    .sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime() || a.id.localeCompare(b.id));

  for (const batch of ordered) {
    if (remaining === 0) break;
    const taken = Math.min(remaining, Math.floor(batch.quantity / size));
    if (taken > 0) {
      allocations.push({ batchId: batch.id, units: taken });
      remaining -= taken;
    }
  }
  return remaining === 0 ? allocations : null;
}

/** Whole selling units available across sellable batches. */
export function availableUnits(batches: StockBatch[], size: number, now: Date): number {
  return batches.filter((batch) => isSellable(batch, now)).reduce((sum, batch) => sum + Math.floor(batch.quantity / size), 0);
}
