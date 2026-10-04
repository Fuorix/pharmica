export const PRICE_SOURCES = ["SRO", "COMPANY_PRICE_LIST", "DISTRIBUTOR_INVOICE", "SHOP_REPORT", "DRAP_IMPORT", "MANUAL"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export interface PriceEntry {
  price: number;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * The official price in force at `now`: the entry with the latest effective date that has already
 * started. Ties go to the most recently recorded entry. Future-dated entries are ignored until they start.
 */
export function resolveCurrentPrice<T extends PriceEntry>(history: T[], now: Date): T | null {
  let current: T | null = null;
  for (const entry of history) {
    if (entry.effectiveFrom.getTime() > now.getTime()) continue;
    if (!current
      || entry.effectiveFrom.getTime() > current.effectiveFrom.getTime()
      || (entry.effectiveFrom.getTime() === current.effectiveFrom.getTime() && entry.createdAt.getTime() > current.createdAt.getTime())) {
      current = entry;
    }
  }
  return current;
}

/** The next scheduled price change after `now`, if any. */
export function nextScheduledPrice<T extends PriceEntry>(history: T[], now: Date): T | null {
  return history
    .filter((entry) => entry.effectiveFrom.getTime() > now.getTime())
    .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())[0] ?? null;
}
