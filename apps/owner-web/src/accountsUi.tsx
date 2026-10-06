import type { AgeBuckets, LedgerLine } from "@pharmica/contracts";

export const money = (value: number) => `PKR ${value.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-PK", { dateStyle: "medium" });

const typeLabels: Record<string, string> = { CREDIT_SALE: "Credit sale", PAYMENT: "Payment", CREDIT_RETURN: "Return / void", ADJUSTMENT: "Adjustment", PURCHASE: "Purchase" };

/** What is owed by age: 0-30, 31-60, 61-90, 90+ days. */
export function AgeingBar({ buckets }: { buckets: AgeBuckets }) {
  const parts: Array<[string, number, string]> = [["0-30", buckets.current, "age-0"], ["31-60", buckets.days31to60, "age-1"], ["61-90", buckets.days61to90, "age-2"], ["90+", buckets.over90, "age-3"]];
  return <span className="ageing">{parts.filter(([, amount]) => amount > 0).map(([label, amount, tone]) => <em key={label} className={tone}>{label}d {money(amount)}</em>)}</span>;
}

export function LedgerTable({ entries }: { entries: LedgerLine[] }) {
  return <table className="detail-table"><thead><tr><th>Date</th><th>What</th><th>Amount</th><th>Balance</th><th>By</th><th>Details</th></tr></thead><tbody>
    {entries.map((entry) => <tr key={entry.id}>
      <td>{new Date(entry.at).toLocaleString("en-PK", { dateStyle: "short", timeStyle: "short" })}</td>
      <td>{typeLabels[entry.type] ?? entry.type}</td>
      <td className={entry.amount < 0 ? "credit" : ""}>{entry.amount < 0 ? `−${money(-entry.amount)}` : money(entry.amount)}</td>
      <td>{money(entry.balanceAfter)}</td>
      <td>{entry.by}</td>
      <td>{[entry.method, entry.reference, entry.note].filter(Boolean).join(" · ")}</td>
    </tr>)}
  </tbody></table>;
}
