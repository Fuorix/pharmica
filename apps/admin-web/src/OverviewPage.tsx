import { useState } from "react";
import type { AdminOverview } from "@pharmica/contracts";
import type { Section } from "./App";
import { Message, money, send, useApi } from "./ui";

/** The control room: platform totals and the work waiting for the team. */
export function OverviewPage({ go }: { go: (section: Section) => void }) {
  const { data, error, reload } = useApi<AdminOverview>("/api/v1/admin/overview");
  const [message, setMessage] = useState("");
  if (error) return <p className="message">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const queue: Array<[string, number, string, Section]> = [
    ["Shop price reports to review", data.queue.priceReports, "Review", "catalogue"],
    ["Price lists waiting for review", data.queue.priceLists, "Review", "catalogue"],
    ["Online payments to match", data.queue.unmatchedPayments, "Match", "collections"],
    ["Shops overdue or in grace", data.queue.overdueShops, "Collect", "collections"],
    ["New shops still onboarding", data.queue.onboarding, "Onboard", "tenants"],
    ["Failed or conflicting uploads", data.queue.syncProblems, "Support", "tenants"]
  ];

  async function runBilling() {
    try {
      const result = await send<{ subscriptions: number; changed: number }>("/api/v1/admin/billing/run", "POST", {});
      setMessage(`✓ Checked ${result.subscriptions} subscriptions; ${result.changed} changed status`);
      await reload();
    } catch (failure) {
      setMessage((failure as Error).message);
    }
  }

  return <>
    <header className="page-head"><div><p className="eyebrow">TODAY</p><h2>Platform overview</h2></div><button className="ghost" onClick={() => void runBilling()}>Run billing check</button></header>
    <Message text={message} />
    <div className="stats">
      <div><span>Pharmacies</span><strong>{data.tenants.active}</strong><small>{data.tenants.newThisMonth} new this month{data.tenants.suspended ? ` · ${data.tenants.suspended} suspended` : ""}</small></div>
      <div><span>Monthly recurring revenue</span><strong>{money(data.mrr)}</strong><small>Collected this month {money(data.collectedThisMonth)}</small></div>
      <div><span>Subscriptions</span><strong>{data.subscriptions.ACTIVE} paying</strong><small>{data.subscriptions.TRIAL} trial · {data.subscriptions.GRACE} grace · {data.subscriptions.EXPIRED} expired</small></div>
    </div>
    <article className="queue">
      <div className="queue-title"><h3>Work queue</h3><span>{queue.filter(([, count]) => count > 0).length} need attention</span></div>
      {queue.map(([title, count, action, section]) => <div className="queue-row" key={title}>
        <div><strong>{title}</strong><span>{count === 0 ? "Nothing waiting" : `${count} waiting`}</span></div>
        <button disabled={count === 0} onClick={() => go(section)}>{action}</button>
      </div>)}
    </article>
  </>;
}
