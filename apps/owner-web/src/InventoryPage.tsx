import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { InventoryItem, StockAdjustmentType } from "@pharmica/contracts";
import { apiFetch, errorMessage, jsonBody } from "./session";

type Filter = "all" | "low" | "near-expiry" | "expired";
type Movement = { id: string; at: string; type: string; quantity: number; batchNo: string | null; batchBalance: number; reason: string | null; by: string };

const money = (value: number) => `PKR ${value.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("en-PK", { dateStyle: "medium" }) : "—";
function stockLabel(quantity: number, item: InventoryItem) {
  const perPack = item.unitsPerPack * item.tabletsPerStrip;
  if (perPack <= 1) return `${quantity}`;
  const packs = Math.floor(quantity / perPack);
  const loose = quantity % perPack;
  return loose ? `${packs} packs + ${loose}` : `${packs} packs`;
}
const typeLabels: Record<string, string> = { OPENING: "Opening", RECEIPT: "Received", SALE: "Sold", SALE_RETURN: "Returned / voided", COUNT: "Count", ADJUSTMENT: "Correction", WRITE_OFF: "Written off", DAMAGE: "Damaged", EXPIRY: "Expired", RETURN_TO_SUPPLIER: "Back to supplier" };

export function InventoryPage({ branchId }: { branchId: string }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [mismatches, setMismatches] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [adjust, setAdjust] = useState({ batchId: "", type: "WRITE_OFF" as StockAdjustmentType, packs: "", loose: "", reason: "" });

  const load = useCallback(async () => {
    const [stock, check] = await Promise.all([apiFetch(`/api/v1/inventory?branchId=${branchId}`), apiFetch(`/api/v1/inventory/ledger?branchId=${branchId}`)]);
    if (stock.ok) setItems((await stock.json()).items);
    if (check.ok) setMismatches((await check.json()).mismatches.length);
  }, [branchId]);

  useEffect(() => { void load(); }, [load]);

  const open = items.find((item) => item.productId === openId);
  useEffect(() => {
    if (!openId) return;
    void apiFetch(`/api/v1/inventory/ledger?productId=${openId}`).then(async (response) => { if (response.ok) setMovements((await response.json()).movements); });
  }, [openId, items]);

  const visible = useMemo(() => items.filter((item) =>
    (!query.trim() || `${item.name} ${item.generic ?? ""} ${item.company ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    && (filter === "all" || (filter === "low" && item.lowStock) || (filter === "near-expiry" && item.nearExpiry > 0) || (filter === "expired" && item.expired > 0))), [items, query, filter]);

  const totals = {
    low: items.filter((item) => item.lowStock).length,
    near: items.filter((item) => item.nearExpiry > 0).length,
    expired: items.filter((item) => item.expired > 0).length,
    cost: items.reduce((sum, item) => sum + item.valueAtCost, 0),
    retail: items.reduce((sum, item) => sum + item.valueAtRetail, 0)
  };

  async function submitAdjust(event: FormEvent) {
    event.preventDefault();
    if (!open) return;
    const perPack = open.unitsPerPack * open.tabletsPerStrip;
    const amount = Number(adjust.packs || 0) * perPack + Number(adjust.loose || 0);
    const response = await apiFetch("/api/v1/inventory", { method: "PATCH", ...jsonBody({ batchId: adjust.batchId || open.batches[0]?.id, type: adjust.type, quantity: adjust.type === "ADJUSTMENT" ? amount : -amount, reason: adjust.reason }) });
    if (!response.ok) return setMessage(await errorMessage(response, "Could not change stock"));
    const result = await response.json();
    setMessage(result.shortBy ? `Saved; only ${-result.applied} units were in stock` : "Stock change saved");
    setAdjust({ ...adjust, packs: "", loose: "", reason: "" });
    await load();
  }

  return <>
    <div className="page-heading"><h1>Inventory</h1><span className="page-note">{message}</span><button onClick={() => void load()}>Refresh</button></div>
    <section className="metrics">
      <article><span>Items</span><strong>{items.length}</strong></article>
      <article><span>Low stock</span><strong className={totals.low ? "warning" : ""}>{totals.low}</strong></article>
      <article><span>Expiring in 90 days</span><strong className={totals.near ? "warning" : ""}>{totals.near}</strong></article>
      <article><span>Expired stock</span><strong className={totals.expired ? "warning" : ""}>{totals.expired}</strong></article>
      <article><span>Stock at cost</span><strong>{money(totals.cost)}</strong></article>
      <article><span>Stock at retail</span><strong>{money(totals.retail)}</strong></article>
    </section>
    {mismatches !== null && <p className={mismatches ? "warning page-note" : "page-note"}>{mismatches ? `${mismatches} batch(es) differ from the stock ledger. Contact support.` : "Stock matches the stock ledger for every batch."}</p>}

    <div className="filter-bar">
      {([["all", "All"], ["low", `Low stock (${totals.low})`], ["near-expiry", `Expiring (${totals.near})`], ["expired", `Expired (${totals.expired})`]] as Array<[Filter, string]>).map(([value, label]) => <button key={value} className={filter === value ? "tab active" : "tab"} onClick={() => setFilter(value)}>{label}</button>)}
      <input className="catalogue-search" placeholder="Filter by name, salt, company" value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>

    <article className="panel catalogue-table">
      <div className="catalogue-row catalogue-head stock-row"><span>Item</span><span>Sellable</span><span>Expiring</span><span>Expired</span><span>First expiry</span><span>Value (cost)</span></div>
      {visible.map((item) => <div key={item.productId}>
        <div className={`catalogue-row stock-row clickable ${item.productId === openId ? "open" : ""}`} onClick={() => { setOpenId(item.productId === openId ? null : item.productId); setAdjust({ ...adjust, batchId: item.batches[0]?.id ?? "" }); setMessage(""); }}>
          <div><strong>{item.name}</strong><span>{[item.generic, item.company, item.rackLocation ? `rack ${item.rackLocation}` : null].filter(Boolean).join(" · ")}</span></div>
          <span className={item.lowStock ? "warning" : ""}>{stockLabel(item.sellable, item)}{item.lowStock ? " · low" : ""}</span>
          <span className={item.nearExpiry ? "warning" : ""}>{item.nearExpiry ? stockLabel(item.nearExpiry, item) : "—"}</span>
          <span className={item.expired ? "warning" : ""}>{item.expired ? stockLabel(item.expired, item) : "—"}</span>
          <span>{date(item.nearestExpiry)}</span>
          <span>{money(item.valueAtCost)}</span>
        </div>
        {item.productId === openId && open && <div className="stock-detail">
          <table className="detail-table"><thead><tr><th>Batch</th><th>Expiry</th><th>Stock</th><th>Retail</th><th>Real cost</th></tr></thead><tbody>
            {open.batches.map((batch) => <tr key={batch.id} className={batch.status}><td>{batch.batchNo}</td><td>{date(batch.expiryDate)}{batch.status !== "ok" ? ` · ${batch.status === "expired" ? "expired" : "expiring"}` : ""}</td><td>{stockLabel(batch.quantity, open)}</td><td>{money(batch.retailPrice)}</td><td>{batch.costPrice == null ? "—" : money(batch.costPrice)}</td></tr>)}
          </tbody></table>
          {open.batches.length > 0 && <form className="inventory-form adjust" onSubmit={submitAdjust}>
            <select value={adjust.batchId} onChange={(event) => setAdjust({ ...adjust, batchId: event.target.value })}>{open.batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.batchNo}</option>)}</select>
            <select value={adjust.type} onChange={(event) => setAdjust({ ...adjust, type: event.target.value as StockAdjustmentType })}><option value="WRITE_OFF">Write off</option><option value="DAMAGE">Damaged</option><option value="EXPIRY">Expired</option><option value="ADJUSTMENT">Correction (add)</option></select>
            <input inputMode="numeric" placeholder="Packs" value={adjust.packs} onChange={(event) => setAdjust({ ...adjust, packs: event.target.value.replace(/\D/g, "") })} />
            {open.unitsPerPack * open.tabletsPerStrip > 1 && <input inputMode="numeric" placeholder="Loose units" value={adjust.loose} onChange={(event) => setAdjust({ ...adjust, loose: event.target.value.replace(/\D/g, "") })} />}
            <input required placeholder="Reason (required)" value={adjust.reason} onChange={(event) => setAdjust({ ...adjust, reason: event.target.value })} />
            <button disabled={!adjust.reason.trim() || !(Number(adjust.packs || 0) || Number(adjust.loose || 0))}>Save change</button>
          </form>}
          <h3>Stock ledger</h3>
          <table className="detail-table"><thead><tr><th>When</th><th>What</th><th>Batch</th><th>Change</th><th>Batch balance</th><th>By</th><th>Note</th></tr></thead><tbody>
            {movements.slice(0, 50).map((movement) => <tr key={movement.id}><td>{new Date(movement.at).toLocaleString("en-PK", { dateStyle: "short", timeStyle: "short" })}</td><td>{typeLabels[movement.type] ?? movement.type}</td><td>{movement.batchNo}</td><td className={movement.quantity < 0 ? "warning" : ""}>{movement.quantity > 0 ? `+${movement.quantity}` : movement.quantity}</td><td>{movement.batchBalance}</td><td>{movement.by}</td><td>{movement.reason}</td></tr>)}
          </tbody></table>
        </div>}
      </div>)}
      {!visible.length && <p className="page-note">Nothing to show.</p>}
    </article>
  </>;
}
