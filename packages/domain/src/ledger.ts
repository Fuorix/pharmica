/** Ledger entry types that reduce what is owed; every other type adds to it (ADJUSTMENT amounts carry their own sign). */
const REDUCING = new Set(["PAYMENT", "CREDIT_RETURN"]);

/** Signed effect of one entry on the balance: positive increases what is owed. */
export function ledgerEffect(entry: { type: string; amount: number | { toString(): string } }): number {
  const amount = Number(entry.amount);
  return REDUCING.has(entry.type) ? -amount : amount;
}

/** Amount owed: credit sales or purchases and adjustments, minus payments and returned credit. Works for customer and supplier ledgers. */
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

export interface AgedBalance {
  balance: number;
  /** Date of the oldest charge not yet paid off, or null when nothing is owed. */
  oldestUnpaidAt: Date | null;
  /** Days since the oldest unpaid charge. */
  daysOutstanding: number;
  /** What is owed, by age of the charge: 0-30, 31-60, 61-90, and over 90 days. */
  buckets: { current: number; days31to60: number; days61to90: number; over90: number };
}

/**
 * Ages a ledger the way a shop collects: payments and credits pay off the oldest charges first, and whatever
 * remains is grouped by how long it has been owed.
 */
export function ageLedger(entries: Array<{ type: string; amount: number | { toString(): string }; createdAt: Date }>, now: Date): AgedBalance {
  const ordered = [...entries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const charges: Array<{ at: Date; paisa: number }> = [];
  let credit = 0;
  for (const entry of ordered) {
    const paisa = Math.round(ledgerEffect(entry) * 100);
    if (paisa > 0) charges.push({ at: entry.createdAt, paisa });
    else credit += -paisa;
  }
  for (const charge of charges) {
    const used = Math.min(charge.paisa, credit);
    charge.paisa -= used;
    credit -= used;
  }
  const open = charges.filter((charge) => charge.paisa > 0);
  const buckets = { current: 0, days31to60: 0, days61to90: 0, over90: 0 };
  for (const charge of open) {
    const days = (now.getTime() - charge.at.getTime()) / 86_400_000;
    const key = days <= 30 ? "current" : days <= 60 ? "days31to60" : days <= 90 ? "days61to90" : "over90";
    buckets[key] += charge.paisa;
  }
  const oldest = open[0]?.at ?? null;
  return {
    balance: (open.reduce((sum, charge) => sum + charge.paisa, 0) - credit) / 100,
    oldestUnpaidAt: oldest,
    daysOutstanding: oldest ? Math.floor((now.getTime() - oldest.getTime()) / 86_400_000) : 0,
    buckets: { current: buckets.current / 100, days31to60: buckets.days31to60 / 100, days61to90: buckets.days61to90 / 100, over90: buckets.over90 / 100 }
  };
}

/**
 * Whether a customer may owe `owedAfter` on credit. A limit of 0 allows no credit at all; null means the owner
 * chose no limit for this customer.
 */
export function withinCreditLimit(owedAfter: number, limit: number | null): boolean {
  if (limit === null) return true;
  return owedAfter <= limit + 0.005;
}
