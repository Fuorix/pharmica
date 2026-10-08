import { useState } from "react";
import type { AlertItem, CashBookDay, ProfitAndLoss, ReportTotals, SalesReportRow, ShiftSummary, StockHealthItem } from "@pharmica/contracts";
import { money } from "./accountsUi";
import { AlertList } from "./DashboardPage";
import { CostNote, dateTime, dayLabel, downloadCsv, percent, PeriodPicker, pkToday, TotalsMetrics, useReport, type Period } from "./reportsUi";

type Report = "sales" | "profit" | "cash" | "shifts" | "alerts" | "stock";
type GroupBy = "day" | "product" | "company" | "cashier" | "payment" | "branch";

const groupLabels: Record<GroupBy, string> = { day: "Day", product: "Medicine", company: "Company", cashier: "Cashier", payment: "Payment method", branch: "Branch" };
const paymentLabels: Record<string, string> = { cash: "Cash", card: "Card", credit: "Credit (udhaar)" };

type Scoped = { from: string; to: string; branches: Array<{ id: string; name: string }> };

/** Reports for any period: sales by any grouping, profit and loss, cash book, shifts, alerts, and stock health. */
export function ReportsPage({ scope, branchId }: { scope: string; branchId: string }) {
  const [report, setReport] = useState<Report>("sales");
  const [period, setPeriod] = useState<Period>({ from: pkToday(-6), to: pkToday() });
  const query = `branchId=${scope}&from=${period.from}&to=${period.to}`;
  const tabs: Array<[Report, string]> = [["sales", "Sales"], ["profit", "Profit & loss"], ["cash", "Cash book"], ["shifts", "Shifts"], ["alerts", "Alerts"], ["stock", "Dead stock & reorder"]];

  return <>
    <div className="page-heading no-print"><h1>Reports</h1><button className="secondary" onClick={() => window.print()}>Print</button></div>
    <nav className="filter-bar no-print">{tabs.map(([value, label]) => <button key={value} className={report === value ? "tab active" : "tab"} onClick={() => setReport(value)}>{label}</button>)}</nav>
    {report !== "stock" && <div className="no-print"><PeriodPicker period={period} onChange={setPeriod} /></div>}
    {report === "sales" && <SalesReport query={query} />}
    {report === "profit" && <ProfitReport query={query} />}
    {report === "cash" && <CashBookReport query={query} />}
    {report === "shifts" && <ShiftsReport query={query} />}
    {report === "alerts" && <AlertsReport query={query} />}
    {report === "stock" && <StockHealthReport branchId={branchId} />}
  </>;
}

function Covering({ data, title }: { data: Scoped; title: string }) {
  return <p className="report-covers"><strong>{title}</strong> · {data.from === data.to ? dayLabel(data.from) : `${dayLabel(data.from)} – ${dayLabel(data.to)}`} · {data.branches.map((branch) => branch.name).join(", ")}</p>;
}

function SalesReport({ query }: { query: string }) {
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const { data, error } = useReport<Scoped & { totals: ReportTotals; rows: SalesReportRow[] }>(`/api/v1/reports/sales?${query}&groupBy=${groupBy}`);
  const label = (row: SalesReportRow) => groupBy === "day" ? dayLabel(row.key) : groupBy === "payment" ? paymentLabels[row.label] ?? row.label : row.label;
  return <>
    {error && <p className="banner">{error}</p>}
    {data && <>
      <Covering data={data} title={`Sales by ${groupLabels[groupBy].toLowerCase()}`} />
      <TotalsMetrics totals={data.totals} />
      <CostNote totals={data.totals} />
      <article className="panel catalogue-table">
        <div className="panel-heading no-print">
          <label className="inline-label">Group by <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)}>{(Object.keys(groupLabels) as GroupBy[]).map((key) => <option key={key} value={key}>{groupLabels[key]}</option>)}</select></label>
          <button className="secondary" onClick={() => downloadCsv(`sales-by-${groupBy}-${data.from}-${data.to}`, [groupLabels[groupBy], "Sales", "Discounts", "Returns", "Cost", "Gross profit", "Margin %", "Bills"], data.rows.map((row) => [label(row), row.revenue, row.discounts, row.returns, row.cost, row.grossProfit, row.marginPercent ?? "", row.bills]))}>Download CSV</button>
        </div>
        {data.rows.length ? <table className="detail-table report-table"><thead><tr><th>{groupLabels[groupBy]}</th><th>Sales</th><th>Discounts</th><th>Returns</th><th>Cost</th><th>Gross profit</th><th>Margin</th><th>Bills</th></tr></thead><tbody>
          {data.rows.map((row) => <tr key={row.key}>
            <td>{label(row)}</td><td>{money(row.revenue)}</td><td>{money(row.discounts)}</td><td>{row.returns ? money(row.returns) : "—"}</td><td>{money(row.cost)}</td>
            <td className={row.grossProfit < 0 ? "warning" : ""}>{money(row.grossProfit)}</td><td className={row.marginPercent !== null && row.marginPercent < 5 ? "warning" : ""}>{percent(row.marginPercent)}</td><td>{row.bills}</td>
          </tr>)}
        </tbody></table> : <p className="empty-state">No sales in this period.</p>}
      </article>
    </>}
  </>;
}

function ProfitReport({ query }: { query: string }) {
  const { data, error } = useReport<Scoped & { profitAndLoss: ProfitAndLoss }>(`/api/v1/reports/profit-loss?${query}`);
  if (error) return <p className="banner">{error}</p>;
  if (!data) return null;
  const pnl = data.profitAndLoss;
  const line = (label: string, amount: number, className = "") => <tr className={className}><td>{label}</td><td>{amount < 0 ? `−${money(-amount)}` : money(amount)}</td></tr>;
  return <>
    <Covering data={data} title="Profit and loss" />
    <article className="panel pnl">
      <table className="detail-table"><tbody>
        {line("Sales (after discounts and returns)", pnl.revenue)}
        {line("Cost of medicines sold", -pnl.costOfGoods)}
        {line("Gross profit", pnl.grossProfit, "subtotal")}
        {line("Stock written off, damaged, or expired (at cost)", -pnl.stockLosses)}
        {pnl.expensesByCategory.map((row) => <tr key={row.category}><td>Expense: {row.category}</td><td>−{money(row.amount)}</td></tr>)}
        {!pnl.expensesByCategory.length && line("Expenses", 0)}
        {line("Net profit", pnl.netProfit, pnl.netProfit < 0 ? "total warning" : "total")}
      </tbody></table>
      {pnl.revenueWithoutCost > 0 && <p className="page-note report-note">{money(pnl.revenueWithoutCost)} of sales had no recorded cost and are left out of gross profit.</p>}
    </article>
  </>;
}

function CashBookReport({ query }: { query: string }) {
  const { data, error } = useReport<Scoped & { days: CashBookDay[] }>(`/api/v1/reports/cash-book?${query}`);
  if (error) return <p className="banner">{error}</p>;
  if (!data) return null;
  const sum = (key: keyof Omit<CashBookDay, "day">) => data.days.reduce((total, day) => total + day[key], 0);
  const columns: Array<[keyof Omit<CashBookDay, "day">, string]> = [["cashSales", "Cash sales"], ["repayments", "Credit repaid"], ["refunds", "Cash refunds"], ["expenses", "Cash expenses"], ["supplierPayments", "Paid to suppliers"], ["net", "Net cash"]];
  return <>
    <Covering data={data} title="Cash book" />
    <article className="panel catalogue-table">
      <div className="panel-heading no-print"><span>Cash only. Card and bank amounts are not in this book.</span>
        <button className="secondary" onClick={() => downloadCsv(`cash-book-${data.from}-${data.to}`, ["Day", ...columns.map(([, label]) => label)], data.days.map((day) => [day.day, ...columns.map(([key]) => day[key])]))}>Download CSV</button></div>
      <table className="detail-table report-table"><thead><tr><th>Day</th>{columns.map(([, label]) => <th key={label}>{label}</th>)}</tr></thead><tbody>
        {data.days.map((day) => <tr key={day.day}><td>{dayLabel(day.day)}</td>{columns.map(([key]) => <td key={key} className={key === "net" && day.net < 0 ? "warning" : ""}>{day[key] ? money(day[key]) : "—"}</td>)}</tr>)}
        <tr className="total"><td>Total</td>{columns.map(([key]) => <td key={key}>{money(sum(key))}</td>)}</tr>
      </tbody></table>
    </article>
  </>;
}

function ShiftsReport({ query }: { query: string }) {
  const { data, error } = useReport<Scoped & { shifts: ShiftSummary[] }>(`/api/v1/reports/shifts?${query}`);
  if (error) return <p className="banner">{error}</p>;
  if (!data) return null;
  return <>
    <Covering data={data} title="Shifts" />
    <article className="panel catalogue-table">
      {data.shifts.length ? <table className="detail-table report-table"><thead><tr><th>Opened</th><th>Cashier</th><th>Counter</th><th>Bills</th><th>Sales</th><th>Opening cash</th><th>Expected</th><th>Counted</th><th>Over / short</th></tr></thead><tbody>
        {data.shifts.map((shift) => <tr key={shift.id}>
          <td>{dateTime(shift.openedAt)}{shift.closedAt ? <small>Closed {dateTime(shift.closedAt)}</small> : <small className="warning">Still open</small>}</td>
          <td>{shift.userName}</td><td>{shift.deviceName ?? "—"}</td><td>{shift.bills}</td><td>{money(shift.revenue)}</td><td>{money(shift.openingCash)}</td>
          <td>{shift.expectedCash === null ? "—" : money(shift.expectedCash)}</td><td>{shift.closingCash === null ? "—" : money(shift.closingCash)}</td>
          <td className={shift.variance ? "warning" : ""}>{shift.variance === null ? "—" : shift.variance === 0 ? "Exact" : `${shift.variance > 0 ? "Over" : "Short"} ${money(Math.abs(shift.variance))}`}</td>
        </tr>)}
      </tbody></table> : <p className="empty-state">No shifts in this period.</p>}
    </article>
  </>;
}

function AlertsReport({ query }: { query: string }) {
  const { data, error } = useReport<Scoped & { alerts: AlertItem[] }>(`/api/v1/reports/alerts?${query}`);
  if (error) return <p className="banner">{error}</p>;
  if (!data) return null;
  return <>
    <Covering data={data} title={`Alerts (${data.alerts.length})`} />
    <article className="panel"><AlertList alerts={data.alerts} /></article>
  </>;
}

function StockHealthReport({ branchId }: { branchId: string }) {
  const [deadDays, setDeadDays] = useState(90);
  const { data, error } = useReport<Scoped & { items: StockHealthItem[] }>(`/api/v1/reports/stock-health?branchId=${branchId}&deadDays=${deadDays}`);
  if (error) return <p className="banner">{error}</p>;
  if (!data) return null;
  const dead = data.items.filter((item) => item.reason === "dead");
  const reorder = data.items.filter((item) => item.reason === "reorder");
  const packs = (item: StockHealthItem) => `${Math.floor(item.sellable / item.unitsPerPack)} packs${item.sellable % item.unitsPerPack ? ` + ${item.sellable % item.unitsPerPack}` : ""}`;
  return <>
    <p className="report-covers"><strong>Stock health</strong> · {data.branches.map((branch) => branch.name).join(", ")} · based on the last 30 days of sales</p>
    <article className="panel catalogue-table">
      <div className="panel-heading"><h2>Reorder soon ({reorder.length})</h2>
        <button className="secondary no-print" onClick={() => downloadCsv(`reorder-${pkToday()}`, ["Medicine", "Company", "In stock (packs)", "Sold per day (units)", "Days left", "Suggested packs"], reorder.map((item) => [item.name, item.company ?? "", (item.sellable / item.unitsPerPack).toFixed(1), item.avgDailySold, item.daysOfCover ?? "", item.suggestedPacks]))}>Download order list</button></div>
      {reorder.length ? <table className="detail-table report-table"><thead><tr><th>Medicine</th><th>In stock</th><th>Sold a day</th><th>Lasts</th><th>Order</th></tr></thead><tbody>
        {reorder.map((item) => <tr key={item.productId}><td>{item.name}<small>{item.company}</small></td><td>{packs(item)}</td><td>{item.avgDailySold} units</td><td className="warning">{item.daysOfCover === null ? "Below alert level" : `${item.daysOfCover} days`}</td><td><strong>{item.suggestedPacks} packs</strong></td></tr>)}
      </tbody></table> : <p className="empty-state">Nothing is running low.</p>}
    </article>
    <article className="panel catalogue-table">
      <div className="panel-heading"><h2>Dead stock ({dead.length})</h2>
        <label className="inline-label no-print">Not sold for <select value={deadDays} onChange={(event) => setDeadDays(Number(event.target.value))}>{[30, 60, 90, 180].map((days) => <option key={days} value={days}>{days} days</option>)}</select></label></div>
      {dead.length ? <table className="detail-table report-table"><thead><tr><th>Medicine</th><th>In stock</th><th>Value at cost</th><th>Last sold</th></tr></thead><tbody>
        {dead.map((item) => <tr key={item.productId}><td>{item.name}<small>{item.company}</small></td><td>{packs(item)}</td><td>{money(item.valueAtCost)}</td><td>{item.lastSoldAt ? dateTime(item.lastSoldAt) : "Never"}</td></tr>)}
        <tr className="total"><td>Money tied up</td><td /><td>{money(dead.reduce((sum, item) => sum + item.valueAtCost, 0))}</td><td /></tr>
      </tbody></table> : <p className="empty-state">No dead stock.</p>}
    </article>
  </>;
}
