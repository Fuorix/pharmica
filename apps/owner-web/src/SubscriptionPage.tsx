import { useState } from "react";
import type { BillingOverview, BillingPeriod, InvoiceSummary, PaymentSummary, PlanSummary, SubscriptionSummary } from "@pharmica/contracts";
import { money, shortDate } from "./accountsUi";
import { useReport } from "./reportsUi";
import { apiFetch, errorMessage, jsonBody } from "./session";

const PERIODS: Array<[BillingPeriod, string, number]> = [["MONTHLY", "Monthly", 1], ["QUARTERLY", "Every 3 months", 3], ["YEARLY", "Yearly", 12]];
const statusLabel: Record<SubscriptionSummary["status"], string> = { TRIAL: "Free trial", ACTIVE: "Active", GRACE: "Grace mode", EXPIRED: "Expired", CANCELLED: "Cancelled" };
const methodLabel: Record<PaymentSummary["method"], string> = { CASH: "Cash", BANK_TRANSFER: "Bank transfer", JAZZCASH: "JazzCash", EASYPAISA: "Easypaisa", RAAST: "Raast" };
const featureLabel: Record<string, string> = { reports: "Dashboard and sales reports", accounting: "Profit and loss, cash book, expenses", mobile: "Owner mobile app" };

/** The same prepay arithmetic as the server, to show prices before the owner chooses. */
function priceOf(plan: PlanSummary, months: number) {
  const subtotal = plan.monthlyPrice * months;
  const percent = months === 3 ? plan.quarterlyDiscountPercent : months === 12 ? plan.yearlyDiscountPercent : 0;
  return { subtotal, percent, total: Math.round((subtotal - subtotal * percent / 100) * 100) / 100 };
}

/** One-line state of the subscription for the banner at the top of every page; null when nothing needs saying. */
export function subscriptionNotice(subscription: SubscriptionSummary | undefined): { tone: "warning" | "info"; text: string } | null {
  if (!subscription) return null;
  if (subscription.status === "GRACE") return { tone: "warning", text: `Your subscription lapsed on ${shortDate(subscription.paidThrough)}. Counters keep billing, but cloud sync and reports are paused until you renew.` };
  if (subscription.status === "EXPIRED" || subscription.status === "CANCELLED") return { tone: "warning", text: "Your subscription has ended. Counters keep billing and your data can still be exported; renew to turn sync and reports back on." };
  if (subscription.renewalDue) return { tone: "info", text: `${subscription.status === "TRIAL" ? "Your free trial ends" : "Your subscription renews"} in ${subscription.daysLeft} day${subscription.daysLeft === 1 ? "" : "s"} (${shortDate(subscription.paidThrough)}).` };
  return null;
}

function printDocument(title: string, lines: Array<[string, string]>, footer: string) {
  const win = window.open("", "_blank", "width=420,height=600");
  if (!win) return;
  const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
  win.document.write(`<!doctype html><title>${escape(title)}</title><body style="font-family:sans-serif;padding:24px"><h2>Pharmica</h2><h3>${escape(title)}</h3><table>${lines.map(([label, value]) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${escape(label)}</td><td>${escape(value)}</td></tr>`).join("")}</table><p style="margin-top:24px;color:#555">${escape(footer)}</p></body>`);
  win.document.close();
  win.print();
}

export function SubscriptionPage({ onChanged }: { onChanged: () => void }) {
  const { data, error, reload } = useReport<BillingOverview>("/api/v1/billing");
  const [message, setMessage] = useState("");
  const [choice, setChoice] = useState<{ period: BillingPeriod; planCode: string } | null>(null);
  if (error) return <><div className="page-heading"><h1>Subscription</h1></div><p className="banner">{error}</p></>;
  if (!data) return null;
  const { subscription } = data;
  const open = data.invoices.find((invoice) => invoice.status === "OPEN");
  const selected = choice ?? { period: open?.period ?? subscription.period, planCode: subscription.plan.code };
  const paused = Object.entries({ sync: "Cloud sync", reports: "Reports and dashboard", mobile: "Mobile app", manage: "Adding counters and staff" }).filter(([key]) => !subscription.access[key as keyof typeof subscription.access]);

  async function renew() {
    const response = await apiFetch("/api/v1/billing", { method: "POST", ...jsonBody(selected) });
    setMessage(response.ok ? "Invoice ready. Pay it as shown below." : await errorMessage(response, "Could not prepare the invoice"));
    if (response.ok) { setChoice(null); await reload(); onChanged(); }
  }

  const printInvoice = (invoice: InvoiceSummary) => printDocument(`Invoice ${invoice.number}`, [["Plan", `${invoice.planName}, ${invoice.period.toLowerCase()}`], ["Period", `${shortDate(invoice.periodStart)} to ${shortDate(invoice.periodEnd)}`], ["Amount", money(invoice.subtotal)], ["Prepay discount", money(invoice.discount)], ["Total", money(invoice.total)], ["Due", shortDate(invoice.dueAt)], ["Status", invoice.status === "PAID" ? `Paid ${invoice.paidAt ? shortDate(invoice.paidAt) : ""}` : `Open, ${money(invoice.balance)} to pay`]], data.payInstructions);
  const printReceipt = (payment: PaymentSummary) => printDocument(`Payment receipt ${payment.reference ?? ""}`, [["Received", shortDate(payment.receivedAt)], ["Amount", money(payment.amount)], ["Method", methodLabel[payment.method]], ["Reference", payment.reference ?? "—"], ["Invoice", payment.invoiceNumber ?? "—"], ["Recorded by", payment.recordedBy ?? "Online payment"]], "Thank you for using Pharmica.");

  return <>
    <div className="page-heading"><h1>Subscription</h1><span className="page-note">{message}</span></div>
    <section className="metrics">
      <article><span>Plan</span><strong>{subscription.plan.name}</strong><small>{subscription.period.toLowerCase()} billing</small></article>
      <article><span>Status</span><strong className={subscription.status === "GRACE" || subscription.status === "EXPIRED" || subscription.status === "CANCELLED" ? "warning" : ""}>{statusLabel[subscription.status]}</strong><small>{subscription.status === "GRACE" ? `Grace ends ${shortDate(subscription.graceEndsAt)}` : ""}</small></article>
      <article><span>{subscription.status === "TRIAL" ? "Trial ends" : "Paid until"}</span><strong>{shortDate(subscription.paidThrough)}</strong><small>{subscription.daysLeft >= 0 ? `${subscription.daysLeft} days left` : `${-subscription.daysLeft} days ago`}</small></article>
      <article><span>To pay now</span><strong className={open ? "warning" : ""}>{open ? money(open.balance) : "Nothing"}</strong><small>{open ? `Invoice ${open.number}` : ""}</small></article>
    </section>

    <article className="panel">
      <div className="panel-heading"><h2>What your subscription covers</h2></div>
      <p className="page-note">Billing at the counter never stops and you can always export your data, whatever happens to the subscription.</p>
      {paused.length ? <p className="banner">Paused until you renew: {paused.map(([, label]) => label).join(", ")}.</p> : null}
      <ul className="plain-list">{subscription.features.map((feature) => <li key={feature}>{featureLabel[feature] ?? feature}</li>)}
        <li>{subscription.plan.maxBranches == null ? "Any number of branches" : `Up to ${subscription.plan.maxBranches} branch${subscription.plan.maxBranches === 1 ? "" : "es"}`}, {subscription.plan.maxDevices == null ? "any number of counters" : `${subscription.plan.maxDevices} counter${subscription.plan.maxDevices === 1 ? "" : "s"}`}</li></ul>
    </article>

    <article className="panel renew-panel">
      <div className="panel-heading"><h2>Renew</h2><span>Pay for longer and save</span></div>
      <div className="plan-grid">
        {data.plans.map((plan) => <div key={plan.id} className={`plan-card ${selected.planCode === plan.code ? "chosen" : ""}`}>
          <strong>{plan.name}</strong>
          <span>{money(plan.monthlyPrice)} a month</span>
          {PERIODS.map(([period, label, months]) => {
            const price = priceOf(plan, months);
            return <label key={period} className="check"><input type="radio" name="renewal" checked={selected.planCode === plan.code && selected.period === period} onChange={() => setChoice({ planCode: plan.code, period })} />
              {label}: {money(price.total)}{price.percent ? ` (save ${price.percent}%)` : ""}</label>;
          })}
        </div>)}
      </div>
      <div className="row-actions renew-actions">
        <button onClick={() => void renew()}>{open && open.period === selected.period && open.planName === data.plans.find((plan) => plan.code === selected.planCode)?.name ? "Invoice ready" : "Prepare invoice"}</button>
      </div>
      <div className="pay-how">
        <h3>How to pay</h3>
        <p>{data.payInstructions}</p>
        <p className="page-note">{data.onlineMethods.length ? `Online: ${data.onlineMethods.map((method) => methodLabel[method]).join(", ")}.` : "JazzCash, Easypaisa, and Raast payments will appear here once they are connected."}</p>
      </div>
    </article>

    <article className="panel catalogue-table">
      <div className="panel-heading"><h2>Invoices</h2></div>
      {data.invoices.length ? <table className="detail-table"><thead><tr><th>Invoice</th><th>Plan</th><th>Period</th><th>Total</th><th>Status</th><th /></tr></thead><tbody>
        {data.invoices.map((invoice) => <tr key={invoice.id}>
          <td>{invoice.number}<small>Due {shortDate(invoice.dueAt)}</small></td><td>{invoice.planName}, {invoice.period.toLowerCase()}</td>
          <td>{shortDate(invoice.periodStart)} – {shortDate(invoice.periodEnd)}</td><td>{money(invoice.total)}{invoice.discount ? <small>Saved {money(invoice.discount)}</small> : null}</td>
          <td className={invoice.status === "OPEN" ? "warning" : ""}>{invoice.status === "OPEN" ? `Open: ${money(invoice.balance)} due` : invoice.status === "PAID" ? "Paid" : "Void"}</td>
          <td><button className="secondary" onClick={() => printInvoice(invoice)}>Print</button></td>
        </tr>)}
      </tbody></table> : <p className="empty-state">No invoices yet.</p>}
    </article>

    <article className="panel catalogue-table">
      <div className="panel-heading"><h2>Payment history</h2></div>
      {data.payments.length ? <table className="detail-table"><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Receipt / reference</th><th>Invoice</th><th /></tr></thead><tbody>
        {data.payments.map((payment) => <tr key={payment.id}>
          <td>{shortDate(payment.receivedAt)}</td><td>{money(payment.amount)}</td><td>{methodLabel[payment.method]}</td><td>{payment.reference ?? "—"}</td><td>{payment.invoiceNumber ?? "—"}</td>
          <td><button className="secondary" onClick={() => printReceipt(payment)}>Receipt</button></td>
        </tr>)}
      </tbody></table> : <p className="empty-state">No payments yet.</p>}
    </article>
  </>;
}
