import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogueProduct, PaymentMethod, PosCustomer } from "@pharmica/contracts";
import type { BillTotals } from "@pharmica/domain";
import type { HeldBill, QueuedOperation, SyncStatus } from "../local/types";
import { Dialog } from "./Dialog";
import { dateTime, money, parseDiscount, stockLabel } from "./format";

const methods: Array<{ key: string; value: PaymentMethod; label: string }> = [
  { key: "1", value: "cash", label: "Cash" },
  { key: "2", value: "card", label: "Card" },
  { key: "3", value: "credit", label: "Credit (udhaar)" }
];

/** Moves a highlight through a list with the arrow keys. */
function useListKeys(length: number, onEnter: (index: number) => void) {
  const [index, setIndex] = useState(0);
  useEffect(() => { if (index >= length) setIndex(Math.max(0, length - 1)); }, [index, length]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setIndex((current) => Math.min(length - 1, current + 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setIndex((current) => Math.max(0, current - 1)); }
    if (event.key === "Enter" && length) { event.preventDefault(); onEnter(index); }
  };
  return { index, setIndex, onKeyDown };
}

export function PaymentDialog({ totals, method, onMethod, customer, exchangeCredit, onClose, onConfirm }: {
  totals: BillTotals; method: PaymentMethod; onMethod: (method: PaymentMethod) => void; customer: PosCustomer | undefined; exchangeCredit: number;
  onClose: () => void; onConfirm: (cashReceived?: number) => Promise<void>;
}) {
  const due = Math.round((totals.total - exchangeCredit) * 100) / 100;
  const [cash, setCash] = useState(due > 0 ? String(due) : "0");
  const [busy, setBusy] = useState(false);
  const cashRef = useRef<HTMLInputElement>(null);
  const received = Number(cash);
  useEffect(() => { cashRef.current?.select(); }, [method]);

  async function confirm(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm(method === "cash" ? Math.round((received + exchangeCredit) * 100) / 100 : undefined);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title="Take payment" onClose={onClose}>
    <form className="payment" onSubmit={confirm} onKeyDown={(event) => {
      const choice = methods.find((item) => item.key === event.key);
      if (choice && document.activeElement !== cashRef.current) { event.preventDefault(); onMethod(choice.value); }
    }}>
      <div className="payment-total"><span>Total</span><strong>{money(totals.total)}</strong></div>
      {totals.discount > 0 && <p className="muted">Includes {money(totals.discount)} discount</p>}
      {exchangeCredit > 0 && <p className="notice">Exchange credit {money(exchangeCredit)} → {due >= 0 ? `customer pays ${money(due)}` : `give back ${money(-due)}`}</p>}
      <div className="segmented">{methods.map((item) => <button type="button" key={item.value} className={method === item.value ? "active" : ""} onClick={() => onMethod(item.value)}><b>{item.key}</b> {item.label}</button>)}</div>
      {method === "cash" && due > 0 && <label>Cash received<input ref={cashRef} autoFocus inputMode="decimal" value={cash} onChange={(event) => setCash(event.target.value.replace(/[^\d.]/g, ""))} /></label>}
      {method === "cash" && due > 0 && <div className="payment-change"><span>Change</span><strong>{Number.isFinite(received) && received >= due ? money(received - due) : "—"}</strong></div>}
      {method === "credit" && <p className={customer ? "muted" : "warning-text"}>{customer ? `${customer.name} owes ${money(customer.balance)} now${customer.creditLimit > 0 ? `, limit ${money(customer.creditLimit)}` : ""}` : "Choose a customer first (F3)"}</p>}
      <button className="primary" autoFocus={method !== "cash"} disabled={busy || (method === "cash" && due > 0 && !(received >= due)) || (method === "credit" && !customer)}>{busy ? "Saving..." : "Complete sale"} <b>Enter</b></button>
    </form>
  </Dialog>;
}

export function DiscountDialog({ title, base, current, limitNote, onClose, onApply }: { title: string; base: number; current: number; limitNote: string; onClose: () => void; onApply: (amount: number) => string | null }) {
  const [value, setValue] = useState(current ? String(current) : "");
  const [error, setError] = useState("");
  function apply(event: FormEvent) {
    event.preventDefault();
    const amount = parseDiscount(value, base);
    if (amount === null) return setError("Enter an amount like 50 or a percentage like 10%");
    if (amount > base) return setError(`Discount cannot be more than ${money(base)}`);
    const problem = onApply(amount);
    if (problem) setError(problem);
  }
  return <Dialog title={title} onClose={onClose}>
    <form className="stack" onSubmit={apply}>
      <p className="muted">On {money(base)}. Type an amount (50) or a percentage (10%). {limitNote}</p>
      <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="0" />
      {error && <p className="warning-text">{error}</p>}
      <button className="primary">Apply <b>Enter</b></button>
    </form>
  </Dialog>;
}

export function CustomerDialog({ customers, selectedId, onClose, onSelect, onCreate }: {
  customers: PosCustomer[]; selectedId?: string; onClose: () => void; onSelect: (customer: PosCustomer | undefined) => void;
  onCreate: (input: { name: string; phone?: string; creditLimit?: number }) => Promise<PosCustomer>;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", creditLimit: "" });
  const [error, setError] = useState("");
  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    return customers.filter((customer) => !text || customer.name.toLowerCase().includes(text) || customer.phone?.includes(text)).slice(0, 50);
  }, [customers, query]);
  const list = useListKeys(matches.length, (index) => onSelect(matches[index]));

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      onSelect(await onCreate({ name: form.name, phone: form.phone || undefined, creditLimit: form.creditLimit ? Number(form.creditLimit) : undefined }));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not add customer");
    }
  }

  return <Dialog title="Customer" onClose={onClose} wide>
    {creating ? <form className="stack" onSubmit={create}>
      <input autoFocus required placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      <input placeholder="Mobile number" inputMode="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
      <input placeholder="Credit limit in PKR (0 = no limit)" inputMode="decimal" value={form.creditLimit} onChange={(event) => setForm({ ...form, creditLimit: event.target.value.replace(/[^\d.]/g, "") })} />
      {error && <p className="warning-text">{error}</p>}
      <div className="row"><button type="button" onClick={() => setCreating(false)}>Back</button><button className="primary">Add customer</button></div>
    </form> : <div className="stack">
      <input autoFocus placeholder="Search by name or mobile" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Insert" || (event.ctrlKey && event.key.toLowerCase() === "n")) { event.preventDefault(); setCreating(true); setForm({ ...form, name: query }); }
        else list.onKeyDown(event);
      }} />
      <div className="pick-list">{matches.map((customer, index) => <button key={customer.id} className={index === list.index ? "highlight" : customer.id === selectedId ? "chosen" : ""} onMouseEnter={() => list.setIndex(index)} onClick={() => onSelect(customer)}>
        <strong>{customer.name}</strong><span>{customer.phone ?? "No mobile"}</span><span className={customer.balance > 0 ? "owes" : ""}>{customer.balance > 0 ? `owes ${money(customer.balance)}` : "nothing owed"}</span>
      </button>)}</div>
      {!matches.length && <p className="muted">No customers found.</p>}
      <div className="row">
        <button onClick={() => { setCreating(true); setForm({ ...form, name: query }); }}>New customer <b>Ctrl+N</b></button>
        {selectedId && <button onClick={() => onSelect(undefined)}>Remove customer from bill</button>}
      </div>
    </div>}
  </Dialog>;
}

export function HeldDialog({ held, names, onClose, onResume }: { held: HeldBill[]; names: Map<string, string>; onClose: () => void; onResume: (bill: HeldBill) => void }) {
  const list = useListKeys(held.length, (index) => onResume(held[index]));
  return <Dialog title="Held bills" onClose={onClose}>
    <div className="pick-list" tabIndex={0} autoFocus onKeyDown={list.onKeyDown} ref={(element) => element?.focus()}>
      {held.map((bill, index) => <button key={bill.id} className={index === list.index ? "highlight" : ""} onClick={() => onResume(bill)}>
        <strong>{bill.label}</strong><span>{bill.items.map((item) => names.get(item.productId) ?? "Item").join(", ")}</span><span>{dateTime(bill.createdAt)}</span>
      </button>)}
    </div>
    {!held.length && <p className="muted">No held bills.</p>}
  </Dialog>;
}

export function SubstitutesDialog({ product, substitutes, onClose, onPick }: { product: CatalogueProduct; substitutes: CatalogueProduct[]; onClose: () => void; onPick: (product: CatalogueProduct) => void }) {
  const list = useListKeys(substitutes.length, (index) => onPick(substitutes[index]));
  return <Dialog title={`${product.name} is out of stock`} onClose={onClose}>
    <p className="muted">{substitutes.length ? `Same salt (${product.generic}) in stock:` : `Nothing else with ${product.generic ?? "the same salt"} is in stock.`}</p>
    <div className="pick-list" tabIndex={0} onKeyDown={list.onKeyDown} ref={(element) => element?.focus()}>
      {substitutes.map((item, index) => <button key={item.id} className={index === list.index ? "highlight" : ""} onClick={() => onPick(item)}>
        <strong>{item.name}</strong><span>{item.company}</span><span>{money(item.sellingPrice ?? 0)} · {stockLabel(item.stockQuantity, item.unitsPerPack, item.tabletsPerStrip)}</span>
      </button>)}
    </div>
  </Dialog>;
}

export function SyncDialog({ status, outbox, paperWidth, onPaperWidth, onRetry, onSyncNow, onClose }: {
  status: SyncStatus; outbox: QueuedOperation[]; paperWidth: 58 | 80; onPaperWidth: (width: 58 | 80) => void; onRetry: () => void; onSyncNow: () => void; onClose: () => void;
}) {
  const failed = outbox.filter((op) => op.status === "failed");
  return <Dialog title="Sync and settings" onClose={onClose} wide>
    <div className="stack">
      <p>{status.online ? "Connected to Pharmica." : "Offline. Billing continues; changes upload when the connection returns."}</p>
      <p className="muted">{status.pending} waiting to upload · {status.failed} rejected · last upload {status.lastSyncAt ? dateTime(status.lastSyncAt) : "never"} · catalogue from {status.lastSnapshotAt ? dateTime(status.lastSnapshotAt) : "never"}</p>
      {status.error && <p className="warning-text">{status.error}</p>}
      {failed.length > 0 && <div className="pick-list">{failed.map((op) => <div key={op.key} className="failed-op">
        <strong>{op.operation.type}</strong><span>{dateTime(op.operation.occurredAt)}</span><span className="warning-text">{op.error?.message ?? "Rejected"}</span>
      </div>)}</div>}
      <div className="row">
        <button className="primary" disabled={status.syncing} onClick={onSyncNow}>{status.syncing ? "Syncing..." : "Sync now"}</button>
        {failed.length > 0 && <button onClick={onRetry}>Retry rejected</button>}
      </div>
      <label>Receipt paper<select value={paperWidth} onChange={(event) => onPaperWidth(Number(event.target.value) as 58 | 80)}><option value={80}>80 mm</option><option value={58}>58 mm</option></select></label>
    </div>
  </Dialog>;
}

export const SHORTCUTS: Array<[string, string]> = [
  ["F2", "Search medicine / scan barcode"], ["↑ ↓ Enter", "Pick a search result"], ["Alt+↑ / Alt+↓", "Select a bill line"],
  ["+ / −", "Change quantity of the selected line"], ["F4", "Switch pack / strip / tablet"], ["Del", "Remove the selected line"],
  ["F3", "Customer (for credit / udhaar)"], ["F7", "Discount on the selected line"], ["F8", "Discount on the whole bill"],
  ["F9", "Cycle payment: cash, card, credit"], ["F10", "Take payment"], ["F5 / F6", "Hold bill / resume held bill"],
  ["Ctrl+R", "Recent sales: reprint, void, return, exchange"], ["Ctrl+P", "Reprint last receipt"], ["Ctrl+D", "Open cash drawer (recorded)"],
  ["F11", "Shift: end-of-day report and close"], ["F12", "Lock the counter"], ["F1", "This help"]
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return <Dialog title="Keyboard shortcuts" onClose={onClose} wide>
    <table className="shortcuts"><tbody>{SHORTCUTS.map(([keys, action]) => <tr key={keys}><td><kbd>{keys}</kbd></td><td>{action}</td></tr>)}</tbody></table>
  </Dialog>;
}
