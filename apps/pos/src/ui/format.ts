import type { SaleUnit } from "@pharmica/contracts";

export const money = (value: number) => `PKR ${value.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const plainMoney = (value: number) => value.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const dateTime = (iso: string) => new Date(iso).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" });
export const unitLabel = (unit: SaleUnit, quantity: number) => `${quantity} ${unit}${quantity === 1 ? "" : "s"}`;

/** Stock in the largest whole unit, e.g. "3 packs + 4 loose". */
export function stockLabel(quantity: number, unitsPerPack: number, tabletsPerStrip: number): string {
  const perPack = unitsPerPack * tabletsPerStrip;
  if (perPack <= 1) return `${quantity} in stock`;
  const packs = Math.floor(quantity / perPack);
  const loose = quantity % perPack;
  return loose ? `${packs} packs + ${loose} loose` : `${packs} packs`;
}

/** Parses "50" as PKR 50 and "10%" as 10% of `base`. Returns null for anything else. */
export function parseDiscount(input: string, base: number): number | null {
  const text = input.trim();
  if (!text) return 0;
  const percent = text.endsWith("%");
  const value = Number(percent ? text.slice(0, -1) : text);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round((percent ? base * value / 100 : value) * 100) / 100;
}
