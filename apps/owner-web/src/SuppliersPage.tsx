import { FormEvent, MouseEvent, useCallback, useEffect, useState } from "react";
import type { LedgerLine, PayableSummary } from "@pharmica/contracts";
import { AgeingBar, LedgerTable, money } from "./accountsUi";
import { apiFetch, errorMessage, jsonBody } from "./session";

/** Suppliers and payables: what the shop owes each distributor, and paying it off. */
export function SuppliersPage({ branchId }: { branchId: string }) {
  const [suppliers, setSuppliers] = useState<PayableSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerLine[]>([]);
  const [message, setMessage] = useState("");
  const [newSupplier, setNewSupplier] = useState({ name: "", phone: "", address: "" });
  const [edit, setEdit] = useState<{ id: string; name: string; phone: string; address: string } | null>(null);
  const [entry, setEntry] = useState({ kind: "PAYMENT" as "PAYMENT" | "ADJUSTMENT", amount: "", method: "cash", reference: "", reason: "" });

  const load = useCallback(async () => {
    const response = await apiFetch(`/api/v1/suppliers?branchId=${branchId}`);
    if (response.ok) setSuppliers((await response.json()).suppliers);
  }, [branchId]);
  useEffect(() => { void load(); }, [load]);

  const loadLedger = useCallback(async (id: string) => {
    const response = await apiFetch(`/api/v1/suppliers/${id}/ledger`);
    if (response.ok) setLedger((await response.json()).entries);
  }, []);
  useEffect(() => { if (openId) void loadLedger(openId); }, [openId, loadLedger]);

  const open = suppliers.find((supplier) => supplier.id === openId);
  const payable = suppliers.reduce((sum, supplier) => sum + Math.max(0, supplier.balance), 0);

  async function addSupplier(event: FormEvent) {
    event.preventDefault();
    const response = await apiFetch("/api/v1/suppliers", { method: "POST", ...jsonBody({ branchId, ...newSupplier }) });
    setMessage(response.ok ? `${newSupplier.name} added` : await errorMessage(response, "Could not add supplier"));
    if (response.ok) { setNewSupplier({ name: "", phone: "", address: "" }); await load(); }
  }

  function startEdit(supplier: PayableSummary, event: MouseEvent) {
    event.stopPropagation();
    setOpenId(supplier.id);
    setEdit({ id: supplier.id, name: supplier.name, phone: supplier.phone ?? "", address: supplier.address ?? "" });
    setMessage("");
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!edit) return;
    const response = await apiFetch("/api/v1/suppliers", { method: "PATCH", ...jsonBody({ supplierId: edit.id, name: edit.name, phone: edit.phone, address: edit.address }) });
    setMessage(response.ok ? `${edit.name} updated` : await errorMessage(response, "Could not update supplier"));
    if (response.ok) { setEdit(null); await load(); }
  }

  async function saveEntry(event: FormEvent) {
    event.preventDefault();
    if (!open) return;
    const amount = Number(entry.amount);
    const body = entry.kind === "PAYMENT" ? { type: "PAYMENT", amount, method: entry.method, reference: entry.reference || undefined } : { type: "ADJUSTMENT", amount, reason: entry.reason };
    const response = await apiFetch(`/api/v1/suppliers/${open.id}/ledger`, { method: "POST", ...jsonBody(body) });
    setMessage(response.ok ? (entry.kind === "PAYMENT" ? `Paid ${money(amount)} to ${open.name}` : "Adjustment recorded") : await errorMessage(response, "Could not save"));
    if (response.ok) { setEntry({ ...entry, amount: "", reference: "", reason: "" }); await load(); await loadLedger(open.id); }
  }

  return <>
    <div className="page-heading"><h1>Suppliers</h1><span className="page-note">{message}</span></div>
    <section className="metrics">
      <article><span>Suppliers</span><strong>{suppliers.length}</strong></article>
      <article><span>You owe</span><strong>{money(payable)}</strong></article>
      <article><span>Owed 60+ days</span><strong className="warning">{money(suppliers.reduce((sum, supplier) => sum + supplier.buckets.days61to90 + supplier.buckets.over90, 0))}</strong></article>
    </section>

    <article className="panel catalogue-table">
      <div className="catalogue-row catalogue-head account-row has-edit"><span>Supplier</span><span>You owe</span><span>Oldest unpaid</span><span>Phone</span><span>Ageing</span><span /></div>
      {suppliers.map((supplier) => <div key={supplier.id}>
        <div className={`catalogue-row account-row has-edit clickable ${supplier.id === openId ? "open" : ""}`} onClick={() => { setOpenId(supplier.id === openId ? null : supplier.id); setEdit(null); setMessage(""); }}>
          <div><strong>{supplier.name}</strong><span>{supplier.address ?? ""}</span></div>
          <span className={supplier.balance > 0 ? "warning" : ""}>{money(supplier.balance)}</span>
          <span>{supplier.balance > 0 ? `${supplier.daysOutstanding} days` : "—"}</span>
          <span>{supplier.phone ?? "—"}</span>
          <AgeingBar buckets={supplier.buckets} />
          <button type="button" className="icon-button" aria-label={`Edit ${supplier.name}`} title="Edit supplier" onClick={(event) => startEdit(supplier, event)}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm18.71-11.04a1 1 0 0 0 0-1.41l-2.51-2.51a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 2-1.66Z"/></svg>
          </button>
        </div>
        {supplier.id === openId && <div className="stock-detail">
          {edit?.id === supplier.id && <form className="inventory-form" onSubmit={saveEdit}>
            <input required placeholder="Name" value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} />
            <input placeholder="Phone" value={edit.phone} onChange={(event) => setEdit({ ...edit, phone: event.target.value })} />
            <input placeholder="Address" value={edit.address} onChange={(event) => setEdit({ ...edit, address: event.target.value })} />
            <div className="row-actions">
              <button type="submit">Save changes</button>
              <button type="button" className="secondary" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </form>}
          <form className="inventory-form adjust" onSubmit={saveEntry}>
            <select value={entry.kind} onChange={(event) => setEntry({ ...entry, kind: event.target.value as "PAYMENT" | "ADJUSTMENT" })}><option value="PAYMENT">Payment made</option><option value="ADJUSTMENT">Adjustment (+ adds, − reduces)</option></select>
            <input required inputMode="decimal" placeholder={entry.kind === "PAYMENT" ? "Amount" : "e.g. -500"} value={entry.amount} onChange={(event) => setEntry({ ...entry, amount: event.target.value.replace(/[^\d.-]/g, "") })} />
            {entry.kind === "PAYMENT" ? <>
              <select value={entry.method} onChange={(event) => setEntry({ ...entry, method: event.target.value })}><option value="cash">Cash</option><option value="bank">Bank transfer</option><option value="cheque">Cheque</option></select>
              <input required={entry.method !== "cash"} placeholder={entry.method === "cheque" ? "Cheque number" : entry.method === "bank" ? "Bank reference" : "Reference (optional)"} value={entry.reference} onChange={(event) => setEntry({ ...entry, reference: event.target.value })} />
            </> : <input required placeholder="Reason (required)" value={entry.reason} onChange={(event) => setEntry({ ...entry, reason: event.target.value })} />}
            <button>Save</button>
          </form>
          <LedgerTable entries={ledger} name={supplier.name} />
        </div>}
      </div>)}
      {!suppliers.length && <p className="page-note">Suppliers are added when you receive a purchase, or below.</p>}
    </article>

    <article className="panel">
      <div className="panel-heading"><h2>Add a supplier</h2></div>
      <form className="inventory-form" onSubmit={addSupplier}>
        <input required placeholder="Name" value={newSupplier.name} onChange={(event) => setNewSupplier({ ...newSupplier, name: event.target.value })} />
        <input placeholder="Phone" value={newSupplier.phone} onChange={(event) => setNewSupplier({ ...newSupplier, phone: event.target.value })} />
        <input placeholder="Address" value={newSupplier.address} onChange={(event) => setNewSupplier({ ...newSupplier, address: event.target.value })} />
        <button>Add supplier</button>
      </form>
    </article>
  </>;
}
