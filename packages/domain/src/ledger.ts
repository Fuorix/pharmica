/** Ledger entry types that reduce what a customer owes; every other type adds to it. */
const REDUCING = new Set(["PAYMENT", "CREDIT_RETURN"]);

/** Amount the customer owes: credit sales and adjustments minus payments and returned credit. */
export function ledgerBalance(entries: Array<{ type: string; amount: number | { toString(): string } }>): number {
  const paisa = entries.reduce((sum, entry) => {
    const amount = Math.round(Number(entry.amount) * 100);
    return sum + (REDUCING.has(entry.type) ? -amount : amount);
  }, 0);
  return paisa / 100;
}

/** Receipt numbers are unique per branch: the device's short code plus a per-device sequence, e.g. `7K2Q-000123`. */
export function formatReceiptNo(deviceId: string, sequence: number): string {
  return `${deviceId.slice(-4).toUpperCase()}-${String(sequence).padStart(6, "0")}`;
}
