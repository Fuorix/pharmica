import { FormEvent, useMemo, useState } from "react";
import type { CatalogueProduct, PosStaffMember, StockAdjustmentType } from "@pharmica/contracts";
import { NEAR_EXPIRY_DAYS, stockStatus, type PricingBatch, type StockStatus } from "@pharmica/domain";
import type { EngineState, PosEngine } from "../local/engine";
import { searchCatalogue } from "../local/state";
import { stockLabel } from "./format";

type Filter = "all" | "low" | "near" | "expired";
type Row = { product: CatalogueProduct; batches: PricingBatch[]; status: StockStatus };

const adjustmentLabels: Record<StockAdjustmentType, string> = { WRITE_OFF: "Write off", DAMAGE: "Damaged", EXPIRY: "Expired", ADJUSTMENT: "Correction" };

/** Stock rows for the counter, from its working stock (last snapshot plus anything not yet uploaded). */
export function stockRows(state: EngineState, now = new Date()): Row[] {
  const stock = state.stock!;
  const byProduct = new Map<string, PricingBatch[]>();
  for (const batch of stock.batches) byProduct.set(batch.productId, [...(byProduct.get(batch.productId) ?? []), batch]);
  return stock.catalogue.map((product) => {
    const batches = (byProduct.get(product.id) ?? []).filter((batch) => batch.quantity > 0).sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime());
    return { product, batches, status: stockStatus(batches, { now, unitsPerPack: product.unitsPerPack * product.tabletsPerStrip, lowStockPacks: product.lowStockThreshold }) };
  });
}

export function StockPanel({ engine, state, user }: { engine: PosEngine; state: EngineState; user: PosStaffMember }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const rows = useMemo(() => stockRows(state), [state]);
  const counts = { low: rows.filter((row) => row.status.lowStock).length, near: rows.filter((row) => row.status.nearExpiry > 0).length, expired: rows.filter((row) => row.status.expired > 0).length };

  const visible = useMemo(() => {
    const matching = query.trim() ? new Set(searchCatalogue(state.stock!.catalogue, query, 500).map((product) => product.id)) : null;
    return rows.filter((row) => (!matching || matching.has(row.product.id))
      && (filter === "all" || (filter === "low" && row.status.lowStock) || (filter === "near" && row.status.nearExpiry > 0) || (filter === "expired" && row.status.expired > 0)));
  }, [rows, query, filter, state.stock]);
  const selected = rows.find((row) => row.product.id === selectedId);

  /** Runs a change and reports the outcome; resolves true only when it was saved. */
  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    try {
      await action();
      setMessage({ tone: "ok", text: success });
      return true;
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not save" });
      return false;
    }
  }

  return <section className="work-panel">
    <div className="row filters">
      {([["all", `All (${rows.length})`], ["low", `Low stock (${counts.low})`], ["near", `Expiring in ${NEAR_EXPIRY_DAYS} days (${counts.near})`], ["expired", `Expired (${counts.expired})`]] as Array<[Filter, string]>).map(([value, label]) =>
        <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}
      <input aria-label="Filter stock" placeholder="Filter by name, salt, company" value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>
    {message && <p className={`notice-bar ${message.tone}`} role="status">{message.text}</p>}

    <div className="stock-layout">
      <table className="stock-table">
        <thead><tr><th>Item</th><th>Rack</th><th>Sellable</th><th>Expires first</th><th>Alerts</th></tr></thead>
        <tbody>{visible.map((row) => <tr key={row.product.id} className={row.product.id === selectedId ? "selected" : ""} onClick={() => { setSelectedId(row.product.id); setMessage(null); }}>
          <td><strong>{row.product.name}</strong><small>{row.product.generic ?? row.product.category}</small></td>
          <td>{row.product.rackLocation ?? "—"}</td>
          <td>{stockLabel(row.status.sellable, row.product.unitsPerPack, row.product.tabletsPerStrip)}</td>
          <td>{row.status.nearestExpiry ? row.status.nearestExpiry.toISOString().slice(0, 10) : "—"}</td>
          <td className="alerts">{row.status.lowStock && <em className="tag">Low</em>}{row.status.nearExpiry > 0 && <em className="tag">Expiring</em>}{row.status.expired > 0 && <em className="tag controlled">Expired stock</em>}</td>
        </tr>)}</tbody>
      </table>

      {selected && <ProductStock key={selected.product.id} row={selected} onAdjust={(batchId, type, quantity, reason) => run(() => engine.adjustStock(user, { batchId, type, quantity, reason }), "Stock change saved")}
        onCount={(lines, reason) => run(async () => { const changed = await engine.countStock(user, lines, reason); if (!changed) throw new Error("The count matches the stock; nothing to change"); }, "Count saved")}
        onSettings={(rackLocation, lowStockThreshold) => run(() => engine.updateProduct(user, selected.product.id, { rackLocation, lowStockThreshold }), "Saved")} />}
    </div>
  </section>;
}

function ProductStock({ row, onAdjust, onCount, onSettings }: {
  row: Row;
  onAdjust: (batchId: string, type: StockAdjustmentType, quantity: number, reason: string) => Promise<boolean>;
  onCount: (lines: Array<{ batchId: string; counted: number }>, reason: string) => Promise<boolean>;
  onSettings: (rackLocation: string | null, lowStockThreshold: number) => Promise<boolean>;
}) {
  const { product } = row;
  const perPack = product.unitsPerPack * product.tabletsPerStrip;
  const [adjust, setAdjust] = useState({ batchId: row.batches[0]?.id ?? "", type: "WRITE_OFF" as StockAdjustmentType, packs: "", loose: "", reason: "" });
  const [counted, setCounted] = useState<Record<string, { packs: string; loose: string }>>({});
  const [rack, setRack] = useState(product.rackLocation ?? "");
  const [alertPacks, setAlertPacks] = useState(String(product.lowStockThreshold));
  const now = Date.now();
  const units = (packs: string, loose: string) => Number(packs || 0) * perPack + Number(loose || 0);

  function submitAdjust(event: FormEvent) {
    event.preventDefault();
    const amount = units(adjust.packs, adjust.loose);
    // Corrections may add stock; every other kind removes it.
    void onAdjust(adjust.batchId, adjust.type, adjust.type === "ADJUSTMENT" ? amount : -amount, adjust.reason).then((saved) => { if (saved) setAdjust({ ...adjust, packs: "", loose: "", reason: "" }); });
  }

  function submitCount(event: FormEvent) {
    event.preventDefault();
    const lines = row.batches.filter((batch) => counted[batch.id]).map((batch) => ({ batchId: batch.id, counted: units(counted[batch.id].packs, counted[batch.id].loose) }));
    void onCount(lines, "Physical count").then((saved) => { if (saved) setCounted({}); });
  }

  return <aside className="product-stock">
    <h3>{product.name}</h3>
    <table className="return-table"><thead><tr><th>Batch</th><th>Expiry</th><th>In stock</th><th>Counted (packs + loose)</th></tr></thead><tbody>
      {row.batches.map((batch) => {
        const days = (batch.expiryDate.getTime() - now) / 86_400_000;
        return <tr key={batch.id}>
          <td>{batch.batchNo}<small>PKR {batch.retailPrice.toFixed(2)}</small></td>
          <td className={days <= 0 ? "warning-text" : days < NEAR_EXPIRY_DAYS ? "near" : ""}>{batch.expiryDate.toISOString().slice(0, 10)}{days <= 0 ? " (expired)" : ""}</td>
          <td>{stockLabel(batch.quantity, product.unitsPerPack, product.tabletsPerStrip)}</td>
          <td className="count-inputs">
            <input aria-label={`Counted packs of ${batch.batchNo}`} inputMode="numeric" placeholder="packs" value={counted[batch.id]?.packs ?? ""} onChange={(event) => setCounted({ ...counted, [batch.id]: { packs: event.target.value.replace(/\D/g, ""), loose: counted[batch.id]?.loose ?? "" } })} />
            {perPack > 1 && <input aria-label={`Counted loose units of ${batch.batchNo}`} inputMode="numeric" placeholder="loose" value={counted[batch.id]?.loose ?? ""} onChange={(event) => setCounted({ ...counted, [batch.id]: { packs: counted[batch.id]?.packs ?? "", loose: event.target.value.replace(/\D/g, "") } })} />}
          </td>
        </tr>;
      })}
    </tbody></table>
    {!row.batches.length && <p className="hint">No stock. Receive some under Receive stock (Ctrl+2).</p>}
    {row.batches.length > 0 && <form onSubmit={submitCount}><button disabled={!Object.keys(counted).length}>Save count</button></form>}

    {row.batches.length > 0 && <form className="stack adjust-form" onSubmit={submitAdjust}>
      <h4>Write-off or correction</h4>
      <div className="row">
        <select aria-label="Batch" value={adjust.batchId} onChange={(event) => setAdjust({ ...adjust, batchId: event.target.value })}>{row.batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.batchNo}</option>)}</select>
        <select aria-label="Kind" value={adjust.type} onChange={(event) => setAdjust({ ...adjust, type: event.target.value as StockAdjustmentType })}>{Object.entries(adjustmentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <input aria-label="Packs" inputMode="numeric" placeholder="packs" value={adjust.packs} onChange={(event) => setAdjust({ ...adjust, packs: event.target.value.replace(/\D/g, "") })} />
        {perPack > 1 && <input aria-label="Loose units" inputMode="numeric" placeholder="loose" value={adjust.loose} onChange={(event) => setAdjust({ ...adjust, loose: event.target.value.replace(/\D/g, "") })} />}
      </div>
      <input required placeholder="Reason (required)" value={adjust.reason} onChange={(event) => setAdjust({ ...adjust, reason: event.target.value })} />
      <button className="primary" disabled={!units(adjust.packs, adjust.loose) || !adjust.reason.trim()}>{adjust.type === "ADJUSTMENT" ? "Add stock" : "Remove stock"}</button>
    </form>}

    <form className="stack adjust-form" onSubmit={(event) => { event.preventDefault(); void onSettings(rack.trim() || null, Number(alertPacks || 0)); }}>
      <h4>Shelf and alert</h4>
      <div className="row">
        <label>Rack<input value={rack} onChange={(event) => setRack(event.target.value.toUpperCase())} placeholder="e.g. A-3" /></label>
        <label>Alert below (packs)<input inputMode="numeric" value={alertPacks} onChange={(event) => setAlertPacks(event.target.value.replace(/\D/g, ""))} /></label>
      </div>
      <button>Save</button>
    </form>
  </aside>;
}
