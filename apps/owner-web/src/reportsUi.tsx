import { useCallback, useEffect, useState } from "react";
import type { ReportTotals } from "@pharmica/contracts";
import { money } from "./accountsUi";
import { apiFetch, errorMessage } from "./session";

const DAY_MS = 86_400_000;
/** Pakistan time is UTC+5 all year; reports and their day boundaries follow it. */
export const pkToday = (offsetDays = 0) => new Date(Date.now() + 5 * 3_600_000 + offsetDays * DAY_MS).toISOString().slice(0, 10);

export type Period = { from: string; to: string };

const presets: Array<[string, () => Period]> = [
  ["Today", () => ({ from: pkToday(), to: pkToday() })],
  ["Yesterday", () => ({ from: pkToday(-1), to: pkToday(-1) })],
  ["Last 7 days", () => ({ from: pkToday(-6), to: pkToday() })],
  ["This month", () => ({ from: `${pkToday().slice(0, 8)}01`, to: pkToday() })],
  ["Last month", () => {
    const start = new Date(`${pkToday().slice(0, 8)}01T00:00:00Z`);
    const end = new Date(start.getTime() - DAY_MS);
    return { from: `${end.toISOString().slice(0, 8)}01`, to: end.toISOString().slice(0, 10) };
  }]
];

export function PeriodPicker({ period, onChange }: { period: Period; onChange: (period: Period) => void }) {
  const active = presets.find(([, make]) => { const value = make(); return value.from === period.from && value.to === period.to; })?.[0];
  return <div className="filter-bar period-picker">
    {presets.map(([label, make]) => <button key={label} className={active === label ? "tab active" : "tab"} onClick={() => onChange(make())}>{label}</button>)}
    <label>From <input type="date" value={period.from} max={period.to} onChange={(event) => event.target.value && onChange({ ...period, from: event.target.value })} /></label>
    <label>To <input type="date" value={period.to} min={period.from} onChange={(event) => event.target.value && onChange({ ...period, to: event.target.value })} /></label>
  </div>;
}

/** Loads a report and reloads it whenever the path changes. */
export function useReport<T>(path: string | null): { data: T | null; error: string; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const response = await apiFetch(path);
      if (response.ok) { setData(await response.json() as T); setError(""); } else setError(await errorMessage(response, "Could not load the report"));
    } catch {
      setError("Cannot reach Pharmica. Check the internet connection.");
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}

export const percent = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;

export function TotalsMetrics({ totals }: { totals: ReportTotals }) {
  return <section className="metrics">
    <article><span>Sales (after discounts and returns)</span><strong>{money(totals.revenue)}</strong></article>
    <article><span>Gross profit</span><strong className={totals.grossProfit < 0 ? "warning" : ""}>{money(totals.grossProfit)}</strong></article>
    <article><span>Margin</span><strong>{percent(totals.marginPercent)}</strong></article>
    <article><span>Bills</span><strong>{totals.bills}</strong></article>
  </section>;
}

/** Notes that keep the numbers honest: sales whose cost is unknown are not counted as profit. */
export function CostNote({ totals }: { totals: ReportTotals }) {
  if (totals.revenueWithoutCost <= 0) return null;
  return <p className="page-note report-note">{money(totals.revenueWithoutCost)} of sales were made before cost prices were recorded and are left out of profit and margin.</p>;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Saves the table on screen as a CSV file the owner can open in Excel. */
export function downloadCsv(name: string, header: string[], rows: unknown[][]) {
  const text = "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  saveBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), `${name}.csv`);
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const dateTime = (iso: string) => new Date(iso).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" });
export const dayLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-PK", { weekday: "short", day: "numeric", month: "short" });
