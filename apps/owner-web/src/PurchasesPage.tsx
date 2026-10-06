import { FormEvent, useCallback, useEffect, useState } from "react";
import type { CatalogueProduct, CatalogueSearchResponse, MasterProductSummary, PurchaseSummary, ReceivePurchaseResponse } from "@pharmica/contracts";
import { apiFetch, errorMessage, jsonBody } from "./session";

type Line = { key: string; productId?: string; masterProductId?: string; name: string; official: number | null; batchNo: string; expiryDate: string; quantity: string; bonusQuantity: string; costPrice: string; discount: string; retailPrice: string };
type PriceReport = { id: string; oldPrice: string; newPrice: string; createdAt: string; product: { name: string; masterProduct: { name: string } | null }; batch: { batchNo: string } | null; purchase: { invoiceNumber: string | null; supplier: { name: string } } | null };

const money = (value: number) => `PKR ${value.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (value: string) => Number(value || 0);

export function PurchasesPage({ branchId }: { branchId: string }) {
  const [purchases, setPurchases] = useState<PurchaseSummary[]>([]);
  const [reports, setReports] = useState<PriceReport[]>([]);
  const [header, setHeader] = useState({ supplier: "", invoiceNumber: "", invoiceDate: new Date().toISOString().slice(0, 10), invoiceDiscount: "" });
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ products: CatalogueProduct[]; masterMatches: MasterProductSummary[] }>({ products: [], masterMatches: [] });
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string; notes?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, priceReports] = await Promise.all([apiFetch(`/api/v1/purchases?branchId=${branchId}`), apiFetch(`/api/v1/price-reports?branchId=${branchId}`)]);
    if (list.ok) setPurchases((await list.json()).purchases);
    if (priceReports.ok) setReports((await priceReports.json()).reports);
  }, [branchId]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (query.trim().length < 2) return setMatches({ products: [], masterMatches: [] });
    const timer = window.setTimeout(async () => {
      const response = await apiFetch(`/api/v1/catalogue?branchId=${branchId}&q=${encodeURIComponent(query.trim())}`);
      if (response.ok) setMatches(await response.json() as CatalogueSearchResponse);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, branchId]);

  function addLine(item: { id: string; name: string; officialRetailPrice: number | null; sellingPrice?: number | null }, kind: "branch" | "master") {
    setLines([...lines, { key: crypto.randomUUID(), ...(kind === "branch" ? { productId: item.id } : { masterProductId: item.id }), name: item.name, official: item.officialRetailPrice, batchNo: "", expiryDate: "", quantity: "", bonusQuantity: "0", costPrice: "", discount: "0", retailPrice: String(item.sellingPrice ?? item.officialRetailPrice ?? "") }]);
    setQuery("");
  }
  const update = (key: string, change: Partial<Line>) => setLines(lines.map((line) => line.key === key ? { ...line, ...change } : line));

  const subtotal = lines.reduce((sum, line) => sum + num(line.quantity) * num(line.costPrice), 0);
  const lineDiscount = lines.reduce((sum, line) => sum + num(line.discount), 0);
  const total = subtotal - lineDiscount - num(header.invoiceDiscount);
  const bonus = lines.reduce((sum, line) => sum + num(line.bonusQuantity), 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await apiFetch("/api/v1/purchases", { method: "POST", ...jsonBody({
        branchId,
        supplier: { name: header.supplier },
        invoiceNumber: header.invoiceNumber || undefined,
        invoiceDate: header.invoiceDate || undefined,
        invoiceDiscount: num(header.invoiceDiscount),
        lines: lines.map((line) => ({ productId: line.productId, masterProductId: line.masterProductId, batchNo: line.batchNo, expiryDate: line.expiryDate, quantity: num(line.quantity), bonusQuantity: num(line.bonusQuantity), costPrice: num(line.costPrice), discount: num(line.discount), retailPrice: num(line.retailPrice) }))
      }) });
      if (!response.ok) return setMessage({ tone: "error", text: await errorMessage(response, "Could not receive the invoice") });
      const result = await response.json() as ReceivePurchaseResponse;
      setMessage({ tone: "ok", text: `Received invoice from ${result.purchase.supplier.name}: payable ${money(result.purchase.total)}`, notes: result.warnings });
      setLines([]); setHeader({ ...header, invoiceNumber: "", invoiceDiscount: "" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="page-heading"><h1>Purchases</h1></div>
    <article className="panel">
      <div className="panel-heading"><h2>Receive a supplier invoice</h2><span>Counters can also receive stock at the POS (Ctrl+2), offline too.</span></div>
      <form onSubmit={submit} className="purchase-form">
        <div className="inventory-form">
          <input required placeholder="Supplier" value={header.supplier} onChange={(event) => setHeader({ ...header, supplier: event.target.value })} />
          <input placeholder="Invoice number" value={header.invoiceNumber} onChange={(event) => setHeader({ ...header, invoiceNumber: event.target.value })} />
          <input type="date" value={header.invoiceDate} onChange={(event) => setHeader({ ...header, invoiceDate: event.target.value })} />
          <input inputMode="decimal" placeholder="Invoice discount (PKR)" value={header.invoiceDiscount} onChange={(event) => setHeader({ ...header, invoiceDiscount: event.target.value.replace(/[^\d.]/g, "") })} />
        </div>
        <input className="catalogue-search" placeholder="Add an item: search by name, salt, company, or barcode" value={query} onChange={(event) => setQuery(event.target.value)} />
        {(matches.products.length > 0 || matches.masterMatches.length > 0) && <div className="match-list">
          {matches.products.map((product) => <button type="button" key={product.id} onClick={() => addLine(product, "branch")}>{product.name} <span>{product.company}</span></button>)}
          {matches.masterMatches.map((product) => <button type="button" key={product.id} onClick={() => addLine(product, "master")}>{product.name} <span>{product.company} · new to this branch</span></button>)}
        </div>}
        {lines.length > 0 && <table className="detail-table purchase-lines"><thead><tr><th>Item</th><th>Batch</th><th>Expiry</th><th>Packs</th><th>Bonus</th><th>Cost/pack</th><th>Discount</th><th>Retail/pack</th><th /></tr></thead><tbody>
          {lines.map((line) => <tr key={line.key}>
            <td>{line.name}{line.official != null && line.retailPrice !== "" && Math.abs(num(line.retailPrice) - line.official) > 0.005 ? <small className="warning">differs from master {money(line.official)}</small> : null}</td>
            <td><input required value={line.batchNo} onChange={(event) => update(line.key, { batchNo: event.target.value.toUpperCase() })} /></td>
            <td><input required type="date" value={line.expiryDate} onChange={(event) => update(line.key, { expiryDate: event.target.value })} /></td>
            <td><input inputMode="numeric" value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value.replace(/\D/g, "") })} /></td>
            <td><input inputMode="numeric" value={line.bonusQuantity} onChange={(event) => update(line.key, { bonusQuantity: event.target.value.replace(/\D/g, "") })} /></td>
            <td><input required inputMode="decimal" value={line.costPrice} onChange={(event) => update(line.key, { costPrice: event.target.value.replace(/[^\d.]/g, "") })} /></td>
            <td><input inputMode="decimal" value={line.discount} onChange={(event) => update(line.key, { discount: event.target.value.replace(/[^\d.]/g, "") })} /></td>
            <td><input required inputMode="decimal" value={line.retailPrice} onChange={(event) => update(line.key, { retailPrice: event.target.value.replace(/[^\d.]/g, "") })} /></td>
            <td><button type="button" className="secondary" onClick={() => setLines(lines.filter((entry) => entry.key !== line.key))}>Remove</button></td>
          </tr>)}
        </tbody></table>}
        <div className="purchase-totals">
          <span>Subtotal <b>{money(subtotal)}</b></span><span>Line discounts <b>−{money(lineDiscount)}</b></span><span>Invoice discount <b>−{money(num(header.invoiceDiscount))}</b></span><span>Bonus packs <b>{bonus}</b></span><span>Payable <b>{money(total)}</b></span>
          <button disabled={!lines.length || busy}>{busy ? "Saving..." : "Receive invoice"}</button>
        </div>
        {message && <div className={message.tone === "error" ? "warning" : "page-note"}><p>{message.text}</p>{message.notes?.map((note) => <p key={note} className="warning">{note}</p>)}</div>}
      </form>
    </article>

    <section className="content-grid">
      <article className="panel">
        <div className="panel-heading"><h2>Recent invoices</h2><span>{purchases.length}</span></div>
        {purchases.map((purchase) => <details key={purchase.id} className="purchase-item">
          <summary><strong>{purchase.supplier.name}{purchase.invoiceNumber ? ` #${purchase.invoiceNumber}` : ""}</strong><span>{new Date(purchase.receivedAt).toLocaleDateString("en-PK", { dateStyle: "medium" })} · {purchase.receivedBy} · {money(purchase.total)}{purchase.bonusPacks ? ` · ${purchase.bonusPacks} bonus packs` : ""}</span></summary>
          <p className="page-note">Subtotal {money(purchase.subtotal)} · line discounts {money(purchase.lineDiscount)} · invoice discount {money(purchase.invoiceDiscount)}</p>
          <table className="detail-table"><thead><tr><th>Item</th><th>Batch</th><th>Packs + bonus</th><th>Cost</th><th>Real cost</th><th>Retail</th></tr></thead><tbody>
            {purchase.lines.map((line, index) => <tr key={index}><td>{line.name}</td><td>{line.batchNo} · {line.expiryDate}</td><td>{line.quantity}{line.bonusQuantity ? ` + ${line.bonusQuantity}` : ""}</td><td>{money(line.costPrice)}{line.discount ? ` − ${money(line.discount)}` : ""}</td><td>{money(line.effectiveCost)}</td><td>{money(line.retailPrice)}</td></tr>)}
          </tbody></table>
        </details>)}
        {!purchases.length && <p className="page-note">No invoices yet.</p>}
      </article>
      <article className="panel">
        <div className="panel-heading"><h2>Price changes reported</h2><span>{reports.length} waiting for Pharmica review</span></div>
        {reports.map((report) => <div className="staff-row" key={report.id}>
          <div><strong>{report.product.masterProduct?.name ?? report.product.name}</strong><span>Master {money(Number(report.oldPrice))} → printed {money(Number(report.newPrice))}{report.batch ? ` · batch ${report.batch.batchNo}` : ""}{report.purchase ? ` · ${report.purchase.supplier.name}` : ""}</span></div>
          <span className="page-note">{new Date(report.createdAt).toLocaleDateString("en-PK", { dateStyle: "medium" })}</span>
        </div>)}
        {!reports.length && <p className="page-note">No differences reported.</p>}
      </article>
    </section>
  </>;
}
