import { FormEvent, useCallback, useEffect, useState } from "react";
import type { CatalogueProduct, CatalogueSearchResponse, MasterPriceEntry, MasterProductSummary, ProductCategory } from "@pharmica/contracts";
import { PriceUpdatesPanel } from "./PriceUpdatesPanel";
import { apiFetch, errorMessage, jsonBody } from "./session";

const money = (value: number | null) => value == null ? "—" : `PKR ${value.toFixed(2)}`;
const emptyItem = { name: "", category: "cosmetic" as ProductCategory, company: "", barcode: "", unitsPerPack: 1, tabletsPerStrip: 1, retailPrice: "" };

type PriceHistory = { current: MasterPriceEntry | null; scheduled: MasterPriceEntry | null; history: MasterPriceEntry[] };

export function CataloguePage({ branchId }: { branchId: string }) {
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [masterMatches, setMasterMatches] = useState<MasterProductSummary[]>([]);
  const [message, setMessage] = useState("");
  const [item, setItem] = useState(emptyItem);
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState<{ product: CatalogueProduct; prices: PriceHistory } | null>(null);

  const load = useCallback(async () => {
    const response = await apiFetch(`/api/v1/catalogue?branchId=${branchId}${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}`);
    if (!response.ok) return;
    const data = await response.json() as CatalogueSearchResponse;
    setProducts(data.products);
    setMasterMatches(data.masterMatches);
  }, [branchId, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function send(method: string, body: unknown, success: string) {
    const response = await apiFetch("/api/v1/catalogue", { method, ...jsonBody(body) });
    setMessage(response.ok ? success : await errorMessage(response, "Request failed"));
    if (response.ok) await load();
    return response.ok;
  }

  function edit(product: CatalogueProduct, field: "rackLocation" | "retailPriceOverride" | "lowStockThreshold", label: string) {
    const current = product[field];
    const input = window.prompt(`${label} for ${product.name}${field === "retailPriceOverride" ? " (leave empty to sell at the batch price)" : ""}`, current == null ? "" : String(current));
    if (input === null) return;
    const value = field === "rackLocation" ? input.trim() || null : input.trim() === "" ? null : Number(input);
    if (typeof value === "number" && !Number.isFinite(value)) return setMessage(`${label} must be a number`);
    void send("PATCH", { productId: product.id, [field]: field === "lowStockThreshold" ? value ?? 0 : value }, `${product.name} updated`);
  }

  async function showHistory(product: CatalogueProduct) {
    if (!product.masterProductId) return;
    const response = await apiFetch(`/api/v1/catalogue/master/${product.masterProductId}/prices`);
    if (response.ok) setHistory({ product, prices: await response.json() });
  }

  const isMedicine = item.category === "medicine";
  const tabletsPerPack = (Number(item.unitsPerPack) || 1) * (Number(item.tabletsPerStrip) || 1);

  async function addItem(event: FormEvent) {
    event.preventDefault();
    const ok = await send("POST", {
      branchId,
      name: item.name,
      category: item.category,
      company: item.company || undefined,
      barcode: item.barcode || undefined,
      unitsPerPack: Number(item.unitsPerPack) || 1,
      // Only medicines come in strips of tablets; other items are packs of pieces.
      tabletsPerStrip: isMedicine ? Number(item.tabletsPerStrip) || 1 : 1,
      retailPrice: item.retailPrice === "" ? undefined : Number(item.retailPrice)
    }, `${item.name} added to the shop catalogue`);
    if (ok) { setItem(emptyItem); setAdding(false); }
  }

  return <>
    <div className="page-heading"><h1>Catalogue</h1><span className="page-note">{message}</span>{!adding && <button onClick={() => setAdding(true)}>Add item</button>}</div>
    {adding && <article className="panel add-item-panel">
      <div className="panel-heading"><h2>Add a shop item</h2><span>For items not on the medicine list, such as cosmetics or baby products</span></div>
      <form className="inventory-form" onSubmit={addItem}>
        <label className="field">Item name<input required autoFocus value={item.name} onChange={(event) => setItem({ ...item, name: event.target.value })} /></label>
        <label className="field">Category<select value={item.category} onChange={(event) => setItem({ ...item, category: event.target.value as ProductCategory })}>
          <option value="cosmetic">Cosmetic</option><option value="surgical">Surgical</option><option value="baby">Baby</option><option value="general">General</option><option value="medicine">Medicine (unlisted)</option>
        </select></label>
        <label className="field">Company (optional)<input value={item.company} onChange={(event) => setItem({ ...item, company: event.target.value })} /></label>
        <label className="field">Barcode (optional)<input value={item.barcode} onChange={(event) => setItem({ ...item, barcode: event.target.value })} /></label>
        {isMedicine ? <>
          <label className="field">Strips per pack<input type="number" min="1" max="1000" required value={item.unitsPerPack} onChange={(event) => setItem({ ...item, unitsPerPack: Number(event.target.value) })} /></label>
          <label className="field">Tablets per strip<input type="number" min="1" max="1000" required value={item.tabletsPerStrip} onChange={(event) => setItem({ ...item, tabletsPerStrip: Number(event.target.value) })} /></label>
          <p className="field-note">1 pack = {Number(item.unitsPerPack) || 1} strip{Number(item.unitsPerPack) === 1 ? "" : "s"} × {Number(item.tabletsPerStrip) || 1} tablet{Number(item.tabletsPerStrip) === 1 ? "" : "s"} = {tabletsPerPack} tablets. Use 1 for a medicine sold only whole, such as a syrup.</p>
        </> : <label className="field">Pieces per pack<input type="number" min="1" max="1000" value={item.unitsPerPack} onChange={(event) => setItem({ ...item, unitsPerPack: Number(event.target.value) })} /></label>}
        <label className="field">Price per pack (PKR)<input type="number" min="0" step="0.01" value={item.retailPrice} onChange={(event) => setItem({ ...item, retailPrice: event.target.value })} /></label>
        <div className="form-buttons"><button type="submit">Save item</button><button type="button" className="secondary" onClick={() => { setAdding(false); setItem(emptyItem); }}>Cancel</button></div>
      </form>
    </article>}
    <PriceUpdatesPanel branchId={branchId} onChanged={() => void load()} />
    <input className="catalogue-search" placeholder="Search by brand, salt, company, or barcode" value={query} onChange={(event) => setQuery(event.target.value)} />
    <article className="panel catalogue-table">
      <div className="panel-heading"><h2>In this branch</h2><span>{products.length} items</span></div>
      <div className="catalogue-row catalogue-head"><span>Item</span><span>Stock</span><span>Selling</span><span>Official</span><span>Rack</span><span /></div>
      {products.map((product) => <div className="catalogue-row" key={product.id}>
        <div><strong>{product.name}</strong><span>{[product.generic, product.company, product.category !== "medicine" ? product.category : null, product.isControlled ? "controlled" : product.isPrescriptionOnly ? "Rx" : null].filter(Boolean).join(" · ")}</span></div>
        <span className={product.stockQuantity === 0 ? "warning" : undefined}>{product.stockQuantity === 0 ? "Out" : `${Math.floor(product.stockQuantity / (product.unitsPerPack * product.tabletsPerStrip))} packs`}</span>
        <span>{money(product.sellingPrice)}{product.retailPriceOverride != null ? " *" : ""}</span>
        <span>{money(product.officialRetailPrice)}</span>
        <span>{product.rackLocation ?? "—"}</span>
        <div className="row-actions">
          <button className="secondary" onClick={() => edit(product, "rackLocation", "Rack location")}>Rack</button>
          <button className="secondary" onClick={() => edit(product, "retailPriceOverride", "Shop price per pack")}>Price</button>
          <button className="secondary" onClick={() => edit(product, "lowStockThreshold", "Low-stock alert at (base units)")}>Alert</button>
          {product.masterProductId && <button className="secondary" onClick={() => void showHistory(product)}>History</button>}
        </div>
      </div>)}
      <p className="page-note">* shop price below the batch price. Customers are never charged above a batch's printed retail price.</p>
    </article>

    {history && <article className="panel">
      <div className="panel-heading"><h2>Price history · {history.product.name}</h2><button className="secondary" onClick={() => setHistory(null)}>Close</button></div>
      {history.prices.scheduled && <p className="page-note">Scheduled: {money(history.prices.scheduled.price)} from {new Date(history.prices.scheduled.effectiveFrom).toLocaleDateString()}</p>}
      {history.prices.history.map((entry) => <div className="staff-row" key={entry.id}>
        <div><strong>{money(entry.price)}{entry.id === history.prices.current?.id ? " · current" : ""}</strong><span>{entry.source.replace(/_/g, " ").toLowerCase()}{entry.reference ? ` · ${entry.reference}` : ""}</span></div>
        <span>from {new Date(entry.effectiveFrom).toLocaleDateString()}</span>
      </div>)}
    </article>}

    <article className="panel">
      <div className="panel-heading"><h2>From the medicine list</h2><span>{query.trim() ? `${masterMatches.length} not stocked here` : "Search to find more"}</span></div>
      {masterMatches.map((match) => <div className="staff-row" key={match.id}>
        <div><strong>{match.name}</strong><span>{[match.generic, match.company, match.strength, money(match.officialRetailPrice)].filter(Boolean).join(" · ")}</span></div>
        <button className="secondary" onClick={() => void send("POST", { branchId, masterProductId: match.id }, `${match.name} added; receive stock to start selling it`)}>Add to shop</button>
      </div>)}
    </article>
  </>;
}
