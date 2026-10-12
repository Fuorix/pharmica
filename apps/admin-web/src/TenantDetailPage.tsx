import { FormEvent, useState } from "react";
import type { MigrationStatus, PlanSummary, SupportView, TenantDetail } from "@pharmica/contracts";
import { ago, dateTime, day, Message, money, send, StatusChip, Tabs, useApi } from "./ui";

type Tab = "setup" | "counters" | "subscription" | "support";

export function TenantDetailPage({ id, onBack }: { id: string; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("setup");
  const [message, setMessage] = useState("");
  const { data, error, reload } = useApi<{ tenant: TenantDetail }>(`/api/v1/admin/tenants/${id}`);
  const tenant = data?.tenant;

  /** Runs a change, shows its outcome, and reloads the pharmacy. */
  async function act(run: () => Promise<unknown>, done: string) {
    try {
      const result = await run() as { temporaryPassword?: string } | undefined;
      setMessage(result?.temporaryPassword ? `✓ ${done}. New temporary password: ${result.temporaryPassword}` : `✓ ${done}`);
      await reload();
    } catch (failure) {
      setMessage((failure as Error).message);
    }
  }

  if (error) return <p className="message">{error}</p>;
  if (!tenant) return <p className="muted">Loading…</p>;
  return <>
    <header className="page-head">
      <div><button className="ghost back" onClick={onBack}>← Pharmacies</button><h2>{tenant.name}</h2><p className="muted">{[tenant.contactName, tenant.phone, tenant.city].filter(Boolean).join(" · ")} · since {day(tenant.createdAt)}</p></div>
      <div className="head-side"><StatusChip status={tenant.subscription?.status ?? null} />{!tenant.isActive && <span className="chip expired">Suspended</span>}</div>
    </header>
    <Message text={message} />
    <Tabs value={tab} onChange={setTab} options={[["setup", "Setup"], ["counters", "Counters & staff"], ["subscription", "Subscription"], ["support", "Support"]]} />
    {tab === "setup" && <Setup tenant={tenant} act={act} />}
    {tab === "counters" && <Counters tenant={tenant} act={act} />}
    {tab === "subscription" && <Subscription tenant={tenant} act={act} />}
    {tab === "support" && <Support id={tenant.id} />}
  </>;
}

type Act = (run: () => Promise<unknown>, done: string) => Promise<void>;

function Setup({ tenant, act }: { tenant: TenantDetail; act: Act }) {
  const [migration, setMigration] = useState<MigrationStatus>(tenant.migrationStatus);
  const [note, setNote] = useState(tenant.migrationNote ?? "");
  const path = `/api/v1/admin/tenants/${tenant.id}`;
  const owners = tenant.users.filter((user) => user.role === "owner");
  return <div className="two-col">
    <section className="card">
      <h3>Go-live checklist</h3>
      <ul className="checklist">{tenant.checklist.map((step) => <li key={step.key} className={step.done ? "done" : ""}><span>{step.done ? "✓" : "○"}</span>{step.label}{step.detail ? <small>{step.detail}</small> : null}</li>)}</ul>
    </section>
    <section className="card">
      <h3>Data migration</h3>
      <form className="stack" onSubmit={(event: FormEvent) => { event.preventDefault(); void act(() => send(path, "PATCH", { migrationStatus: migration, migrationNote: note }), "Migration status saved"); }}>
        <select value={migration} onChange={(event) => setMigration(event.target.value as MigrationStatus)}>
          <option value="NOT_STARTED">Not started</option><option value="IN_PROGRESS">In progress</option><option value="DONE">Done</option><option value="NOT_NEEDED">Not needed (new shop)</option>
        </select>
        <textarea placeholder="Notes, e.g. old software, file received, what is left" value={note} onChange={(event) => setNote(event.target.value)} />
        <button>Save</button>
      </form>
      <h3>Owner access</h3>
      {owners.map((owner) => <div key={owner.id} className="line">
        <div><strong>{owner.name}</strong><small>{owner.login} · last sign-in {ago(owner.lastLoginAt)}{owner.mustChangeCredential ? " · on temporary password" : ""}</small></div>
        <button className="ghost" onClick={() => { if (window.confirm(`Issue a new temporary password for ${owner.name}? They will be signed out everywhere.`)) void act(() => send(path, "PATCH", { resetPasswordFor: owner.id }), "Password reset"); }}>Reset password</button>
      </div>)}
      <h3>Suspension</h3>
      <p className="muted">Suspending signs everyone out and stops cloud sync. Counters keep billing offline. Not for unpaid subscriptions; grace mode handles those.</p>
      <button className={tenant.isActive ? "danger" : ""} onClick={() => {
        const reason = window.prompt(tenant.isActive ? "Why suspend this pharmacy?" : "Why restore this pharmacy?");
        if (reason) void act(() => send(path, "PATCH", { isActive: !tenant.isActive, reason }), tenant.isActive ? "Pharmacy suspended" : "Pharmacy restored");
      }}>{tenant.isActive ? "Suspend pharmacy" : "Restore pharmacy"}</button>
    </section>
  </div>;
}

function Counters({ tenant, act }: { tenant: TenantDetail; act: Act }) {
  const [branch, setBranch] = useState({ name: "", address: "", phone: "" });
  const [counter, setCounter] = useState({ branchId: tenant.branches[0]?.id ?? "", name: "" });
  const branchName = (id: string | null) => tenant.branches.find((candidate) => candidate.id === id)?.name ?? "All branches";
  return <div className="two-col">
    <section className="card">
      <h3>Branches</h3>
      {tenant.branches.map((candidate) => <div key={candidate.id} className="line"><div><strong>{candidate.name}</strong><small>{[candidate.address, candidate.phone].filter(Boolean).join(" · ") || "No address yet"}</small></div></div>)}
      <form className="inline-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void act(() => send(`/api/v1/admin/tenants/${tenant.id}/branches`, "POST", { name: branch.name, address: branch.address || undefined, phone: branch.phone || undefined }), `Branch ${branch.name} added`).then(() => setBranch({ name: "", address: "", phone: "" })); }}>
        <input required placeholder="New branch name" value={branch.name} onChange={(event) => setBranch({ ...branch, name: event.target.value })} />
        <input placeholder="Address" value={branch.address} onChange={(event) => setBranch({ ...branch, address: event.target.value })} />
        <button>Add branch</button>
      </form>
      <h3>Staff</h3>
      {tenant.users.map((user) => <div key={user.id} className={`line ${user.isActive ? "" : "inactive"}`}><div><strong>{user.name}</strong><small>{user.role} · {user.login} · {branchName(user.branchId)}{user.hasPin ? " · has PIN" : ""}</small></div><small>{ago(user.lastLoginAt)}</small></div>)}
    </section>
    <section className="card">
      <h3>Counters</h3>
      {tenant.devices.map((device) => <div key={device.id} className={`line ${device.isActive ? "" : "inactive"}`}>
        <div><strong>{device.name}</strong><small>{branchName(device.branchId)} · {device.activatedAt ? `activated ${day(device.activatedAt)}, seen ${ago(device.lastSeenAt)}` : <>code <code>{device.activationCode}</code></>}{device.isActive ? "" : " · deactivated"}</small></div>
        <div className="row">
          <button className="ghost" onClick={() => void act(() => send("/api/v1/devices", "PATCH", { deviceId: device.id, resetActivation: true }), `${device.name} has a new activation code`)}>New code</button>
          <button className="ghost" onClick={() => void act(() => send("/api/v1/devices", "PATCH", { deviceId: device.id, isActive: !device.isActive }), device.isActive ? `${device.name} deactivated` : `${device.name} activated`)}>{device.isActive ? "Deactivate" : "Activate"}</button>
        </div>
      </div>)}
      <form className="inline-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void act(() => send("/api/v1/devices", "POST", counter), `${counter.name} added`).then(() => setCounter({ ...counter, name: "" })); }}>
        <select value={counter.branchId} onChange={(event) => setCounter({ ...counter, branchId: event.target.value })}>{tenant.branches.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select>
        <input required placeholder="Counter name" value={counter.name} onChange={(event) => setCounter({ ...counter, name: event.target.value })} />
        <button>Add counter</button>
      </form>
    </section>
  </div>;
}

function Subscription({ tenant, act }: { tenant: TenantDetail; act: Act }) {
  const { data: plans } = useApi<{ plans: PlanSummary[] }>("/api/v1/admin/plans");
  const subscription = tenant.subscription;
  const open = tenant.invoices.find((invoice) => invoice.status === "OPEN");
  const [payment, setPayment] = useState({ amount: "", method: "CASH", reference: "", note: "" });
  const [change, setChange] = useState({ planCode: subscription?.plan.code ?? "", period: subscription?.period ?? "MONTHLY" });
  const path = `/api/v1/admin/tenants/${tenant.id}/subscription`;
  if (!subscription) return <p className="message">This pharmacy has no subscription.</p>;
  const ask = (question: string) => window.prompt(question)?.trim();

  return <div className="two-col">
    <section className="card">
      <h3>{subscription.plan.name} · {subscription.period.toLowerCase()}</h3>
      <dl className="facts">
        <dt>Status</dt><dd><StatusChip status={subscription.status} /></dd>
        <dt>{subscription.isTrial ? "Trial ends" : "Paid through"}</dt><dd>{day(subscription.paidThrough)} ({subscription.daysLeft} days)</dd>
        <dt>Grace ends</dt><dd>{day(subscription.graceEndsAt)}</dd>
        <dt>Paused</dt><dd>{Object.entries(subscription.access).filter(([, allowed]) => !allowed).map(([key]) => key).join(", ") || "Nothing"}</dd>
      </dl>
      <form className="inline-form" onSubmit={(event: FormEvent) => {
        event.preventDefault();
        const reason = ask("Reason for the change");
        if (reason) void act(() => send(path, "PATCH", { planCode: change.planCode !== subscription.plan.code ? change.planCode : undefined, period: change.period !== subscription.period ? change.period : undefined, reason }), "Subscription changed");
      }}>
        <select value={change.planCode} onChange={(event) => setChange({ ...change, planCode: event.target.value })}>{plans?.plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}</select>
        <select value={change.period} onChange={(event) => setChange({ ...change, period: event.target.value as typeof change.period })}><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="YEARLY">Yearly</option></select>
        <button>Change</button>
      </form>
      <div className="row wrap">
        <button className="ghost" onClick={() => { const days = Number(ask("Extend by how many days? (1-90)")); const reason = days ? ask("Why? e.g. promised to pay on Friday") : null; if (days && reason) void act(() => send(path, "PATCH", { extendDays: days, reason }), `Extended ${days} days`); }}>Extend</button>
        <button className="ghost" onClick={() => void act(() => send(path, "POST", {}), "Renewal invoice issued")}>Issue invoice</button>
        {subscription.status === "CANCELLED"
          ? <button className="ghost" onClick={() => { const reason = ask("Why reactivate?"); if (reason) void act(() => send(path, "PATCH", { reactivate: true, reason }), "Subscription reactivated"); }}>Reactivate</button>
          : <button className="ghost danger" onClick={() => { const reason = ask("Why cancel? Counters keep billing; cloud features stop."); if (reason) void act(() => send(path, "PATCH", { cancel: true, reason }), "Subscription cancelled"); }}>Cancel</button>}
      </div>
      <h3>History</h3>
      <ul className="timeline">{tenant.events.map((event) => <li key={event.id}><small>{dateTime(event.createdAt)}{event.actor ? ` · ${event.actor}` : ""}</small>{event.reason ?? event.type}</li>)}</ul>
    </section>
    <section className="card">
      <h3>Record a payment</h3>
      {open ? <form className="stack" onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void act(() => send("/api/v1/admin/payments", "POST", { invoiceId: open.id, amount: Number(payment.amount), method: payment.method, reference: payment.reference, note: payment.note || undefined }), `Payment of ${money(Number(payment.amount))} recorded`).then(() => setPayment({ amount: "", method: "CASH", reference: "", note: "" }));
      }}>
        <p className="muted">Invoice {open.number}: {money(open.balance)} due of {money(open.total)}</p>
        <input required inputMode="decimal" placeholder={`Amount (up to ${open.balance})`} value={payment.amount} onChange={(event) => setPayment({ ...payment, amount: event.target.value.replace(/[^\d.]/g, "") })} />
        <select value={payment.method} onChange={(event) => setPayment({ ...payment, method: event.target.value })}><option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option></select>
        <input required placeholder="Receipt number or bank reference" value={payment.reference} onChange={(event) => setPayment({ ...payment, reference: event.target.value })} />
        <input placeholder="Note" value={payment.note} onChange={(event) => setPayment({ ...payment, note: event.target.value })} />
        <button>Record payment</button>
      </form> : <p className="muted">No open invoice. Issue one to take a payment.</p>}
      <h3>Invoices</h3>
      <table className="grid compact"><tbody>{tenant.invoices.map((invoice) => <tr key={invoice.id}>
        <td>{invoice.number}<small>{invoice.planName}, {invoice.period.toLowerCase()} · {day(invoice.periodStart)}–{day(invoice.periodEnd)}</small></td>
        <td>{money(invoice.total)}</td>
        <td>{invoice.status === "OPEN" ? <span className="warn">{money(invoice.balance)} due</span> : invoice.status.toLowerCase()}</td>
        <td>{invoice.status === "OPEN" && invoice.balance === invoice.total && <button className="ghost" onClick={() => { const reason = ask(`Void ${invoice.number}? Reason:`); if (reason) void act(() => send("/api/v1/admin/invoices", "PATCH", { invoiceId: invoice.id, reason }), `${invoice.number} voided`); }}>Void</button>}</td>
      </tr>)}</tbody></table>
      <h3>Payments</h3>
      <table className="grid compact"><tbody>{tenant.payments.map((entry) => <tr key={entry.id}><td>{day(entry.receivedAt)}<small>{entry.method.replace("_", " ").toLowerCase()} · {entry.reference ?? "—"}</small></td><td>{money(entry.amount)}</td><td>{entry.status.toLowerCase()}</td><td>{entry.invoiceNumber ?? ""}</td></tr>)}</tbody></table>
    </section>
  </div>;
}

function Support({ id }: { id: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, error } = useApi<SupportView>(`/api/v1/admin/tenants/${id}/support${cursor ? `?cursor=${cursor}` : ""}`);
  if (error) return <p className="message">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return <>
    <p className="muted">{data.counts.products} items · {data.counts.batches} batches · {data.counts.sales} sales · {data.counts.customers} customers · {data.counts.openIssues} sync issues awaiting the owner</p>
    <section className="card">
      <h3>Counters</h3>
      <table className="grid"><thead><tr><th>Counter</th><th>Seen</th><th>Version</th><th>Waiting</th><th>Rejected</th><th>Last error</th><th>Server side</th></tr></thead><tbody>
        {data.devices.map((device) => <tr key={device.id}>
          <td><strong>{device.name}</strong><small>{device.branchName}{device.isActive ? "" : " · deactivated"}{device.activated ? "" : " · not activated"}</small></td>
          <td>{ago(device.lastSeenAt)}<small>report {ago(device.diagnosticsAt)}</small></td>
          <td>{device.diagnostics?.appVersion ?? "—"}</td>
          <td className={device.diagnostics?.pending ? "warn" : ""}>{device.diagnostics?.pending ?? "—"}<small>{device.diagnostics?.oldestPendingAt ? `oldest ${ago(device.diagnostics.oldestPendingAt)}` : ""}</small></td>
          <td className={device.diagnostics?.failed ? "warn" : ""}>{device.diagnostics?.failed ?? "—"}</td>
          <td>{device.diagnostics?.lastError ?? "—"}</td>
          <td><small>{device.operations.applied} applied · {device.operations.failed} failed · {device.operations.conflicts} conflicts · {device.operations.flaggedUnreviewed} to review</small></td>
        </tr>)}
      </tbody></table>
    </section>
    <section className="card">
      <h3>Uploads needing attention</h3>
      {data.problems.length ? <table className="grid compact"><tbody>{data.problems.map((problem) => <tr key={problem.id}><td>{problem.type}<small>{problem.deviceName} · {dateTime(problem.occurredAt)}</small></td><td>{problem.status.toLowerCase()}{problem.flags.length ? <small>{problem.flags.join(", ")}</small> : null}</td><td>{problem.error ?? ""}<small>{problem.retryCount ? `${problem.retryCount} retries` : ""}</small></td></tr>)}</tbody></table> : <p className="muted">Nothing stuck.</p>}
    </section>
    <section className="card">
      <h3>Audit history</h3>
      <table className="grid compact"><tbody>{data.audit.map((entry) => <tr key={entry.id}><td>{dateTime(entry.createdAt)}</td><td>{entry.action}<small>{[entry.userName, entry.branchName].filter(Boolean).join(" · ")}</small></td><td><small>{entry.metadata ? JSON.stringify(entry.metadata).slice(0, 140) : ""}</small></td></tr>)}</tbody></table>
      <div className="row">{cursor && <button className="ghost" onClick={() => setCursor(null)}>Newest</button>}{data.nextAuditCursor && <button className="ghost" onClick={() => setCursor(data.nextAuditCursor)}>Older</button>}</div>
    </section>
  </>;
}
