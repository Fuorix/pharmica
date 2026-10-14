import type { AlertItem, DashboardResponse } from "@pharmica/contracts";
import { money } from "./accountsUi";
import { CostNote, dateTime, dayLabel, percent, useReport } from "./reportsUi";

const severityLabel = { high: "Important", medium: "Check", low: "Info" } as const;

export function AlertList({ alerts }: { alerts: AlertItem[] }) {
  if (!alerts.length) return <p className="empty-state">Nothing unusual.</p>;
  return <div className="alert-list">
    {alerts.map((alert) => <div key={alert.id} className={`alert-row ${alert.severity}`}>
      <em>{severityLabel[alert.severity]}</em>
      <div><strong>{alert.description}</strong><span>{[dateTime(alert.at), alert.userName, alert.branchName].filter(Boolean).join(" · ")}</span></div>
    </div>)}
  </div>;
}

/** Today at a glance: sales, profit, cash expected in the drawers, stock warnings, and anything unusual. */
export function DashboardPage({ scope }: { scope: string }) {
  const { data, error, loading, reload } = useReport<DashboardResponse>(`/api/v1/reports/dashboard?branchId=${scope}`);
  const best = data ? Math.max(1, ...data.last7Days.map((day) => day.revenue)) : 1;
  const drawer = data?.branches.filter((branch) => branch.cashInDrawer !== null) ?? [];
  const unsynced = data?.branches.reduce((sum, branch) => sum + branch.unsyncedCounters, 0) ?? 0;

  return <>
    <div className="page-heading">
      <h1>Today</h1>
      <span className="page-note">{error || (data ? `Updated ${dateTime(data.generatedAt)}` : loading ? "Loading…" : "")} <button className="secondary" onClick={() => void reload()}>Refresh</button></span>
    </div>
    {data && <>
      {unsynced > 0 && <p className="banner">{unsynced} counter{unsynced === 1 ? " has" : "s have"} sales not yet uploaded ({data.branches.reduce((sum, branch) => sum + branch.pendingUploads, 0)} waiting). Today's figures will change when they come online.</p>}
      <section className="metrics">
        <article><span>Sales today</span><strong>{money(data.totals.revenue)}</strong></article>
        <article><span>Gross profit</span><strong className={data.totals.grossProfit < 0 ? "warning" : ""}>{money(data.totals.grossProfit)}</strong><small>Margin {percent(data.totals.marginPercent)}</small></article>
        <article><span>Bills</span><strong>{data.totals.bills}</strong><small>{data.totals.returns > 0 ? `Returns ${money(data.totals.returns)}` : "No returns"}</small></article>
        <article><span>Cash in open drawers</span><strong>{drawer.length ? money(drawer.reduce((sum, branch) => sum + (branch.cashInDrawer ?? 0), 0)) : "—"}</strong><small>{drawer.length ? `${drawer.reduce((sum, branch) => sum + branch.openShifts, 0)} shift(s) open` : "No shift open"}</small></article>
      </section>
      <CostNote totals={data.totals} />

      <div className="content-grid dashboard-grid">
        <article className="panel">
          <div className="panel-heading"><h2>Last 7 days</h2><span>Sales and gross profit</span></div>
          <div className="bars">
            {data.last7Days.map((day) => <div key={day.day} className="bar-row" title={`${money(day.revenue)} sales, ${money(day.grossProfit)} profit`}>
              <span>{dayLabel(day.day)}</span>
              <div className="bar"><i style={{ width: `${day.revenue / best * 100}%` }} /><b style={{ width: `${Math.max(0, day.grossProfit) / best * 100}%` }} /></div>
              <span>{money(day.revenue)}</span>
            </div>)}
          </div>
        </article>
        <article className="panel">
          <div className="panel-heading"><h2>Top items today</h2></div>
          {data.topItems.length ? <table className="detail-table"><thead><tr><th>Item</th><th>Sales</th><th>Profit</th></tr></thead><tbody>
            {data.topItems.map((item) => <tr key={item.productId}><td>{item.name}</td><td>{money(item.revenue)}</td><td>{money(item.grossProfit)}</td></tr>)}
          </tbody></table> : <p className="empty-state">No sales yet today.</p>}
        </article>
      </div>

      <article className="panel dashboard-branches">
        <div className="panel-heading"><h2>Branches</h2></div>
        <table className="detail-table"><thead><tr><th>Branch</th><th>Sales</th><th>Profit</th><th>Bills</th><th>Cash in drawer</th><th>Low stock</th><th>Near expiry</th><th>Counters waiting to upload</th></tr></thead><tbody>
          {data.branches.map((branch) => <tr key={branch.branchId}>
            <td>{branch.branchName}</td><td>{money(branch.today.revenue)}</td><td>{money(branch.today.grossProfit)}</td><td>{branch.today.bills}</td>
            <td>{branch.cashInDrawer === null ? "No shift open" : money(branch.cashInDrawer)}</td>
            <td className={branch.lowStock ? "warning" : ""}>{branch.lowStock}</td>
            <td className={branch.nearExpiry ? "warning" : ""}>{branch.nearExpiry}</td>
            <td className={branch.unsyncedCounters ? "warning" : ""}>{branch.unsyncedCounters ? `${branch.unsyncedCounters} (${branch.pendingUploads} items)` : "All uploaded"}</td>
          </tr>)}
        </tbody></table>
      </article>

      <article className="panel dashboard-branches">
        <div className="panel-heading"><h2>Alerts this week</h2><span>Voids, big discounts, deleted lines, drawer opens, and more</span></div>
        <AlertList alerts={data.alerts} />
      </article>
    </>}
  </>;
}
