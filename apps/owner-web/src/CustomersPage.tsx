import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { LedgerLine, ReceivableSummary } from "@pharmica/contracts";
import { AgeingBar, LedgerTable, money } from "./accountsUi";
import { apiFetch, errorMessage, jsonBody } from "./session";

type Filter = "all" | "owing" | "overdue";

/** Customer credit (khata): who owes what, for how long, and every entry behind it. */
export function CustomersPage({ branchId }: { branchId: string }) {
  const [customers, setCustomers] = useState<ReceivableSummary[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerLine[]>([]);
  const [message, setMessage] = useState("");
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "", creditLimit: "", noLimit: false });
  const [entry, setEntry] = useState({ kind: "PAYMENT" as "PAYMENT" | "ADJUSTMENT", amount: "", method: "cash", reason: "" });

  const load = useCallback(async () => {
    const response = await apiFetch(`/api/v1/customers?branchId=${branchId}`);
    if (response.ok) setCustomers((await response.json()).customers);
  }, [branchId]);
  useEffect(() => { void load(); }, [load]);

  const loadLedger = useCallback(async (id: string) => {
    const response = await apiFetch(`/api/v1/customers/${id}/ledger`);
    if (response.ok) setLedger((await response.json()).entries);
  }, []);
  useEffect(() => { if (openId) void loadLedger(openId); }, [openId, loadLedger]);

  const visible = useMemo(() => customers.filter((customer) =>
    (!query.trim() || `${customer.name} ${customer.phone ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    && (filter === "all" || (filter === "owing" && customer.balance > 0) || (filter === "overdue" && customer.balance > 0 && customer.daysOutstanding > 30))), [customers, query, filter]);
  const owed = customers.reduce((sum, customer) => sum + Math.max(0, customer.balance), 0);
  const overdue = customers.filter((customer) => customer.balance > 0 && customer.daysOutstanding > 30);
  const open = customers.find((customer) => customer.id === openId);

  async function addCustomer(event: FormEvent) {
    event.preventDefault();
    const response = await apiFetch("/api/v1/customers", { method: "POST", ...jsonBody({ branchId, name: newCustomer.name, phone: newCustomer.phone || undefined, creditLimit: newCustomer.noLimit ? null : Number(newCustomer.creditLimit || 0) }) });
    setMessage(response.ok ? `${newCustomer.name} added` : await errorMessage(response, "Could not add customer"));
    if (response.ok) { setNewCustomer({ name: "", phone: "", creditLimit: "", noLimit: false }); await load(); }
  }

  async function saveEntry(event: FormEvent) {
    event.preventDefault();
    if (!open) return;
    const amount = Number(entry.amount);
    const body = entry.kind === "PAYMENT" ? { type: "PAYMENT", amount, method: entry.method } : { type: "ADJUSTMENT", amount, reason: entry.reason };
    const response = await apiFetch(`/api/v1/customers/${open.id}/ledger`, { method: "POST", ...jsonBody(body) });
    setMessage(response.ok ? (entry.kind === "PAYMENT" ? `Payment of ${money(amount)} recorded` : "Adjustment recorded") : await errorMessage(response, "Could not save"));
    if (response.ok) { setEntry({ ...entry, amount: "", reason: "" }); await load(); await loadLedger(open.id); }
  }

  async function edit(customer: ReceivableSummary, change: object, done: string) {
    const response = await apiFetch("/api/v1/customers", { method: "PATCH", ...jsonBody({ customerId: customer.id, ...change }) });
    setMessage(response.ok ? done : await errorMessage(response, "Could not save"));
    if (response.ok) await load();
  }

  return <>
    <div className="page-heading"><h1>Customers</h1><span className="page-note">{message}</span></div>
    <section className="metrics">
      <article><span>Customers</span><strong>{customers.length}</strong></article>
      <article><span>Owed to you</span><strong>{money(owed)}</strong></article>
      <article><span>Overdue (30+ days)</span><strong className={overdue.length ? "warning" : ""}>{overdue.length}</strong></article>
      <article><span>Overdue amount</span><strong className={overdue.length ? "warning" : ""}>{money(overdue.reduce((sum, customer) => sum + customer.balance, 0))}</strong></article>
    </section>
    <div className="filter-bar">
      {([["all", "All"],["owing", "Owing"], ["overdue", `Overdue (${overdue.length})`]] as Array<[Filter, string]>).map(([value, label]) => <button key={value} className={filter === value ? "tab active" : "tab"} onClick={() => setFilter(value)}>{label}</button>)}
      <input className="catalogue-search" placeholder="Search by name or mobile" value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>

    <article className="panel catalogue-table">
      <div className="catalogue-row catalogue-head account-row"><span>Customer</span><span>Owes</span><span>Oldest unpaid</span><span>Limit</span><span>Ageing</span></div>
      {visible.map((customer) => <div key={customer.id}>
        <div className={`catalogue-row account-row clickable ${customer.id === openId ? "open" : ""} ${customer.isActive ? "" : "inactive"}`} onClick={() => { setOpenId(customer.id === openId ? null : customer.id); setMessage(""); }}>
          <div><strong>{customer.name}</strong><span>{customer.phone ?? "No mobile"}{customer.isActive ? "" : " · inactive"}</span></div>
          <span className={customer.balance > 0 ? "warning" : ""}>{money(customer.balance)}</span>
          <span className={customer.daysOutstanding > 30 ? "warning" : ""}>{customer.balance > 0 ? `${customer.daysOutstanding} days` : "—"}</span>
          <span>{customer.creditLimit === null ? "No limit" : customer.creditLimit === 0 ? "No credit" : money(customer.creditLimit)}</span>
          <AgeingBar buckets={customer.buckets} />
        </div>
        {customer.id === openId && <div className="stock-detail">
          <form className="inventory-form adjust" onSubmit={saveEntry}>
            <select value={entry.kind} onChange={(event) => setEntry({ ...entry, kind: event.target.value as "PAYMENT" | "ADJUSTMENT" })}><option value="PAYMENT">Payment received</option><option value="ADJUSTMENT">Adjustment (+ adds, − reduces)</option></select>
            <input required inputMode="decimal" placeholder={entry.kind === "PAYMENT" ? "Amount" : "e.g. -200"} value={entry.amount} onChange={(event) => setEntry({ ...entry, amount: event.target.value.replace(/[^\d.-]/g, "") })} />
            {entry.kind === "PAYMENT" ? <select value={entry.method} onChange={(event) => setEntry({ ...entry, method: event.target.value })}><option value="cash">Cash</option><option value="card">Card</option></select>
              : <input required placeholder="Reason (required)" value={entry.reason} onChange={(event) => setEntry({ ...entry, reason: event.target.value })} />}
            <button>Save</button>
          </form>
          <div className="row-actions">
            <button className="secondary" onClick={() => {
              const value = window.prompt(`Credit limit for ${customer.name} in PKR. 0 = no credit allowed; type "none" for no limit.`, customer.creditLimit === null ? "none" : String(customer.creditLimit));
              if (value === null) return;
              const limit = value.trim().toLowerCase() === "none" ? null : Number(value);
              if (limit !== null && (!Number.isFinite(limit) || limit < 0)) return setMessage("Enter an amount, 0, or none");
              void edit(customer, { creditLimit: limit }, limit === null ? "No credit limit for this customer" : limit === 0 ? "Credit turned off for this customer" : `Credit limit set to ${money(limit)}`);
            }}>Set credit limit</button>
            <button className="secondary" onClick={() => { const value = window.prompt(`Mobile for ${customer.name}`, customer.phone ?? ""); if (value !== null) void edit(customer, { phone: value }, "Mobile saved"); }}>Edit mobile</button>
            <button className="secondary" onClick={() => void edit(customer, { isActive: !customer.isActive }, customer.isActive ? "Customer deactivated; history kept" : "Customer reactivated")}>{customer.isActive ? "Deactivate" : "Reactivate"}</button>
          </div>
          <LedgerTable entries={ledger} name={customer.name} />
        </div>}
      </div>)}
      {!visible.length && <p className="page-note">Nobody here.</p>}
    </article>

    <article className="panel">
      <div className="panel-heading"><h2>Add a customer</h2><span>Counters can add customers too (F3), even offline.</span></div>
      <form className="inventory-form" onSubmit={addCustomer}>
        <input required placeholder="Name" value={newCustomer.name} onChange={(event) => setNewCustomer({ ...newCustomer, name: event.target.value })} />
        <input placeholder="Mobile" value={newCustomer.phone} onChange={(event) => setNewCustomer({ ...newCustomer, phone: event.target.value })} />
        <input inputMode="decimal" placeholder="Credit limit (empty = no credit)" disabled={newCustomer.noLimit} value={newCustomer.creditLimit} onChange={(event) => setNewCustomer({ ...newCustomer, creditLimit: event.target.value.replace(/[^\d.]/g, "") })} />
        <label className="check"><input type="checkbox" checked={newCustomer.noLimit} onChange={(event) => setNewCustomer({ ...newCustomer, noLimit: event.target.checked })} /> No credit limit</label>
        <button>Add customer</button>
      </form>
    </article>
  </>;
}
