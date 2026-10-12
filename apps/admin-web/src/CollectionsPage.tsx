import { useState } from "react";
import type { CollectionsDashboard, InvoiceSummary, PaymentSummary } from "@pharmica/contracts";
import { day, Message, money, send, StatusChip, useApi } from "./ui";

/** Who owes what, who renews soon, churn, and online payments that need a person to match them. */
export function CollectionsPage({ openTenant }: { openTenant: (id: string) => void }) {
  const { data, error, reload } = useApi<CollectionsDashboard>("/api/v1/admin/collections");
  const { data: open } = useApi<{ invoices: InvoiceSummary[] }>("/api/v1/admin/invoices?status=OPEN");
  const [message, setMessage] = useState("");
  if (error) return <p className="message">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  async function match(payment: PaymentSummary, invoiceId: string) {
    try {
      const result = await send<{ invoicePaid: boolean }>("/api/v1/admin/payments", "PATCH", { paymentId: payment.id, invoiceId });
      setMessage(`✓ Matched${result.invoicePaid ? "; the invoice is paid and the subscription extended" : "; the invoice still has a balance"}`);
      await reload();
    } catch (failure) {
      setMessage((failure as Error).message);
    }
  }

  return <>
    <header className="page-head"><div><p className="eyebrow">COLLECTIONS</p><h2>Revenue and collections</h2></div></header>
    <Message text={message} />
    <div className="stats four">
      <div><span>Monthly recurring revenue</span><strong>{money(data.mrr)}</strong><small>{data.counts.ACTIVE} paying shops</small></div>
      <div><span>Collected this month</span><strong>{money(data.collectedThisMonth)}</strong><small>Last month {money(data.collectedLastMonth)}</small></div>
      <div><span>Outstanding</span><strong className={data.outstanding ? "warn" : ""}>{money(data.outstanding)}</strong><small>{data.counts.GRACE} in grace · {data.counts.EXPIRED} expired</small></div>
      <div><span>Churn, 30 days</span><strong>{data.churn30Days.percent == null ? "—" : `${data.churn30Days.percent}%`}</strong><small>{data.churn30Days.lost} of {data.churn30Days.base} shops</small></div>
    </div>

    {!!data.unmatchedPayments.length && <section className="card">
      <h3>Online payments to match</h3>
      <table className="grid compact"><tbody>{data.unmatchedPayments.map((payment) => <tr key={payment.id}>
        <td>{day(payment.receivedAt)}<small>{payment.method} · {payment.reference}</small></td><td>{money(payment.amount)}</td><td><small>{payment.note}</small></td>
        <td><select defaultValue="" onChange={(event) => event.target.value && void match(payment, event.target.value)}>
          <option value="">Match to invoice…</option>
          {open?.invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.number} · {invoice.organisationName} · {money(invoice.balance)} due</option>)}
        </select></td>
      </tr>)}</tbody></table>
    </section>}

    <section className="card">
      <h3>Overdue and grace mode ({data.overdue.length})</h3>
      <table className="grid"><thead><tr><th>Pharmacy</th><th>Status</th><th>Paid through</th><th>Days overdue</th><th>Owes</th></tr></thead><tbody>
        {data.overdue.map((shop) => <tr key={shop.organisationId} className="clickable" onClick={() => openTenant(shop.organisationId)}>
          <td><strong>{shop.name}</strong><small>{shop.phone ?? ""}</small></td><td><StatusChip status={shop.status} /></td><td>{day(shop.paidThrough)}</td>
          <td className={shop.daysOverdue > 14 ? "warn" : ""}>{shop.daysOverdue}</td><td>{money(shop.balance)}</td>
        </tr>)}
      </tbody></table>
      {!data.overdue.length && <p className="muted">Nobody is overdue.</p>}
    </section>

    <div className="two-col">
      <section className="card">
        <h3>Renewing in the next 7 days</h3>
        {data.dueSoon.map((shop) => <div key={shop.organisationId} className="line clickable" onClick={() => openTenant(shop.organisationId)}><div><strong>{shop.name}</strong><small>{shop.status.toLowerCase()} · {day(shop.paidThrough)}</small></div><span>{shop.daysLeft} days</span></div>)}
        {!data.dueSoon.length && <p className="muted">None.</p>}
      </section>
      <section className="card">
        <h3>Recent payments</h3>
        {data.recentPayments.map((payment) => <div key={payment.id} className="line"><div><strong>{payment.organisationName}</strong><small>{day(payment.receivedAt)} · {payment.method.replace("_", " ").toLowerCase()} · {payment.reference ?? ""}</small></div><span>{money(payment.amount)}</span></div>)}
        {!data.recentPayments.length && <p className="muted">No payments yet.</p>}
      </section>
    </div>
  </>;
}
