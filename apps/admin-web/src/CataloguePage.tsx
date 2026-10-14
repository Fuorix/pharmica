import { FormEvent, useState } from "react";
import type { DuplicateCandidate, MasterProductSummary, PriceListRowItem, PriceListUploadSummary, ShopPriceReportGroup } from "@pharmica/contracts";
import { dateTime, day, Message, money, send, Tabs, useApi } from "./ui";
import { apiFetch } from "./session";

type Tab = "reports" | "uploads" | "duplicates";

/** Catalogue curation: nothing reaches shops until someone here has reviewed it. */
export function CataloguePage() {
  const [tab, setTab] = useState<Tab>("reports");
  return <>
    <header className="page-head"><div><p className="eyebrow">CATALOGUE</p><h2>Master list curation</h2></div></header>
    <Tabs value={tab} onChange={setTab} options={[["reports", "Shop price reports"], ["uploads", "SRO & price lists"], ["duplicates", "Duplicates"]]} />
    {tab === "reports" && <ShopReports />}
    {tab === "uploads" && <Uploads />}
    {tab === "duplicates" && <Duplicates />}
  </>;
}

function ShopReports() {
  const { data, reload } = useApi<{ groups: ShopPriceReportGroup[] }>("/api/v1/admin/catalogue/reports");
  const [message, setMessage] = useState("");
  async function settle(group: ShopPriceReportGroup, action: "publish" | "dismiss") {
    const note = action === "dismiss" ? window.prompt("Why dismiss these reports?")?.trim() : undefined;
    if (action === "dismiss" && !note) return;
    try {
      const result = await send<{ reports: number; shops: number }>("/api/v1/admin/catalogue/reports", "POST", { masterProductId: group.masterProductId, reportedPrice: group.reportedPrice, action, note });
      setMessage(`✓ ${action === "publish" ? `${group.name} is now ${money(group.reportedPrice)} for every shop` : "Dismissed"} (${result.reports} reports from ${result.shops} shops)`);
      await reload();
    } catch (failure) {
      setMessage((failure as Error).message);
    }
  }
  return <>
    <p className="muted">When a shop receives a batch printed with a price different from the master list, it is reported here. Publishing sets the master price for every shop.</p>
    <Message text={message} />
    <table className="grid"><thead><tr><th>Medicine</th><th>Master price</th><th>Printed price</th><th>Shops</th><th>Seen</th><th /></tr></thead><tbody>
      {data?.groups.map((group) => <tr key={group.key}>
        <td><strong>{group.name}</strong><small>{group.company ?? ""}</small>{group.examples.slice(0, 2).map((example, index) => <small key={index}>{example.organisationName} · {example.branchName}{example.supplier ? ` · ${example.supplier}` : ""}{example.invoiceNumber ? ` inv ${example.invoiceNumber}` : ""}{example.batchNo ? ` · batch ${example.batchNo}` : ""}</small>)}</td>
        <td>{group.officialPrice == null ? "—" : money(group.officialPrice)}</td>
        <td><strong>{money(group.reportedPrice)}</strong>{group.officialPrice != null && <small className={group.reportedPrice > group.officialPrice ? "warn" : ""}>{group.reportedPrice > group.officialPrice ? "+" : ""}{(group.reportedPrice - group.officialPrice).toFixed(2)}</small>}</td>
        <td>{group.shops}<small>{group.reports} reports</small></td>
        <td>{day(group.lastReportedAt)}</td>
        <td className="row"><button onClick={() => void settle(group, "publish")}>Publish</button><button className="ghost" onClick={() => void settle(group, "dismiss")}>Dismiss</button></td>
      </tr>)}
    </tbody></table>
    {data && !data.groups.length && <p className="muted">No reports waiting.</p>}
  </>;
}

function Uploads() {
  const { data, reload } = useApi<{ uploads: PriceListUploadSummary[] }>("/api/v1/admin/catalogue/uploads");
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState({ source: "SRO", reference: "", effectiveFrom: new Date().toISOString().slice(0, 10) });
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return setMessage("Choose a CSV file");
    try {
      const result = await send<{ upload: PriceListUploadSummary }>("/api/v1/admin/catalogue/uploads", "POST", { ...form, fileName: file.name, csv: await file.text() });
      setMessage(`✓ ${result.upload.counts.rows} rows read: ${result.upload.counts.matched} to change, ${result.upload.counts.notFound + result.upload.counts.ambiguous} to match by hand`);
      setOpenId(result.upload.id);
      await reload();
    } catch (failure) {
      setMessage((failure as Error).message);
    }
  }

  if (openId) return <UploadReview id={openId} onBack={() => { setOpenId(null); void reload(); }} />;
  return <>
    <form className="card inline-form" onSubmit={upload}>
      <select value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })}><option value="SRO">SRO</option><option value="COMPANY_PRICE_LIST">Company price list</option><option value="DRAP_IMPORT">DRAP file</option><option value="MANUAL">Other</option></select>
      <input required placeholder="Reference, e.g. SRO 1234(I)/2026" value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} />
      <label>Effective <input type="date" required value={form.effectiveFrom} onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })} /></label>
      <input type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      <button>Upload for review</button>
    </form>
    <p className="muted">CSV with a header row: a price column (price, retail price, MRP) and a name, barcode, or DRAP registration column.</p>
    <Message text={message} />
    <table className="grid"><thead><tr><th>Reference</th><th>Effective</th><th>Rows</th><th>Status</th><th>Uploaded</th></tr></thead><tbody>
      {data?.uploads.map((upload) => <tr key={upload.id} className="clickable" onClick={() => setOpenId(upload.id)}>
        <td><strong>{upload.reference}</strong><small>{upload.source} · {upload.fileName ?? ""}</small></td>
        <td>{day(upload.effectiveFrom)}</td>
        <td>{upload.counts.rows}<small>{upload.counts.matched} changes · {upload.counts.unchanged} same · {upload.counts.notFound + upload.counts.ambiguous} unmatched · {upload.counts.invalid} invalid</small></td>
        <td><span className={`chip ${upload.status === "REVIEW" ? "grace" : upload.status === "PUBLISHED" ? "active" : "expired"}`}>{upload.status.toLowerCase()}</span><small>{upload.reviewedBy ? `by ${upload.reviewedBy}` : ""}</small></td>
        <td>{dateTime(upload.createdAt)}<small>{upload.uploadedBy}</small></td>
      </tr>)}
    </tbody></table>
  </>;
}

function UploadReview({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, reload } = useApi<{ upload: PriceListUploadSummary; rows: PriceListRowItem[] }>(`/api/v1/admin/catalogue/uploads/${id}`);
  const [filter, setFilter] = useState<"attention" | "changes" | "all">("attention");
  const [message, setMessage] = useState("");
  const [matching, setMatching] = useState<{ rowId: string; query: string; results: MasterProductSummary[] } | null>(null);
  if (!data) return <p className="muted">Loading…</p>;
  const editable = data.upload.status === "REVIEW";
  const rows = data.rows.filter((row) => filter === "all" || (filter === "changes" ? row.match === "MATCHED" : row.match !== "UNCHANGED"));

  async function patch(body: object) {
    try { await send(`/api/v1/admin/catalogue/uploads/${id}`, "PATCH", body); await reload(); } catch (failure) { setMessage((failure as Error).message); }
  }
  async function search(query: string) {
    setMatching((current) => current && { ...current, query });
    if (query.trim().length < 2) return;
    const response = await apiFetch(`/api/v1/catalogue/master?q=${encodeURIComponent(query.trim())}`);
    if (response.ok) { const results = (await response.json() as { products: MasterProductSummary[] }).products.slice(0, 8); setMatching((current) => current && { ...current, results }); }
  }
  async function settle(action: "publish" | "reject") {
    const note = action === "reject" ? window.prompt("Why reject this file?")?.trim() : undefined;
    if (action === "reject" && !note) return;
    if (action === "publish" && !window.confirm(`Publish ${data!.upload.counts.approved} price changes to every shop, effective ${day(data!.upload.effectiveFrom)}?`)) return;
    try {
      const result = await send<{ published: number }>(`/api/v1/admin/catalogue/uploads/${id}`, "POST", { action, note });
      setMessage(action === "publish" ? `✓ ${result.published} prices published` : "✓ File rejected");
      await reload();
    } catch (failure) {
      setMessage((failure as Error).message);
    }
  }

  return <>
    <header className="page-head"><div><button className="ghost back" onClick={onBack}>← Uploads</button><h3>{data.upload.reference}</h3><p className="muted">{data.upload.source} · effective {day(data.upload.effectiveFrom)} · {data.upload.status.toLowerCase()}</p></div>
      {editable && <div className="row"><button onClick={() => void settle("publish")} disabled={!data.upload.counts.approved}>Publish {data.upload.counts.approved} changes</button><button className="ghost" onClick={() => void settle("reject")}>Reject file</button></div>}</header>
    <Message text={message} />
    <Tabs value={filter} onChange={setFilter} options={[["attention", "Needs a look"], ["changes", "Price changes"], ["all", `All ${data.rows.length}`]]} />
    <table className="grid"><thead><tr><th>Line</th><th>In the file</th><th>Master entry</th><th>Now</th><th>New</th><th>Result</th><th /></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}>
        <td>{row.line}</td>
        <td>{row.name}<small>{[row.barcode, row.registrationNo].filter(Boolean).join(" · ")}</small></td>
        <td>{row.masterName ?? "—"}{matching?.rowId === row.id && <div className="match-box">
          <input autoFocus placeholder="Search the master list" value={matching.query} onChange={(event) => void search(event.target.value)} />
          {matching.results.map((product) => <button key={product.id} className="ghost" onClick={() => { setMatching(null); void patch({ rowId: row.id, masterProductId: product.id }); }}>{product.name} <small>{product.company ?? ""} · {product.officialRetailPrice == null ? "no price" : money(product.officialRetailPrice)}</small></button>)}
        </div>}</td>
        <td>{row.currentPrice == null ? "—" : money(row.currentPrice)}</td>
        <td>{row.price == null ? "—" : money(row.price)}</td>
        <td><span className={`chip ${row.match === "MATCHED" ? "active" : row.match === "UNCHANGED" ? "none" : "grace"}`}>{row.match.toLowerCase().replace("_", " ")}</span>{row.problem && <small>{row.problem}</small>}</td>
        <td>{editable && <div className="row">
          {row.match === "MATCHED" && <label className="check"><input type="checkbox" checked={row.approved} onChange={(event) => void patch({ rowId: row.id, approved: event.target.checked })} /> publish</label>}
          {row.price != null && <button className="ghost" onClick={() => setMatching({ rowId: row.id, query: row.name, results: [] })}>Match</button>}
        </div>}</td>
      </tr>)}
    </tbody></table>
  </>;
}

function Duplicates() {
  const { data, reload } = useApi<{ candidates: DuplicateCandidate[]; merges: Array<{ id: string; keptName: string | null; mergedName: string; reason: string | null; relinked: number; unlinked: number; createdAt: string }> }>("/api/v1/admin/catalogue/duplicates");
  const [message, setMessage] = useState("");
  async function merge(keep: DuplicateCandidate["products"][number], drop: DuplicateCandidate["products"][number]) {
    const reason = window.prompt(`Merge "${drop.name}" (${drop.shops} shops) into "${keep.name}" (${keep.shops} shops)? Shops keep all their stock and history. Reason:`)?.trim();
    if (!reason) return;
    try {
      const result = await send<{ relinked: number; unlinked: number }>("/api/v1/admin/catalogue/duplicates", "POST", { keepId: keep.id, mergeId: drop.id, reason });
      setMessage(`✓ Merged: ${result.relinked} shop items moved over, ${result.unlinked} kept as the shop's own item because the shop stocks both`);
      await reload();
    } catch (failure) {
      setMessage((failure as Error).message);
    }
  }
  return <>
    <p className="muted">Pick the entry to keep in each group. The other is hidden everywhere and counters drop it at their next sync; nothing is deleted.</p>
    <Message text={message} />
    {data?.candidates.map((group) => <section key={group.products.map((product) => product.id).join()} className="card">
      <h4>{group.reason}</h4>
      <table className="grid compact"><tbody>{group.products.map((product) => <tr key={product.id}>
        <td><strong>{product.name}</strong><small>{[product.generic, product.strength, product.company].filter(Boolean).join(" · ")}</small></td>
        <td><small>{product.unitsPerPack} × {product.tabletsPerStrip}</small></td>
        <td><small>{product.barcode ?? "no barcode"} · {product.drapRegistrationNo ?? "no reg."}</small></td>
        <td>{product.officialRetailPrice == null ? "—" : money(product.officialRetailPrice)}</td>
        <td>{product.shops} shops</td>
        <td className="row">{group.products.filter((other) => other.id !== product.id).map((other) => <button key={other.id} className="ghost" onClick={() => void merge(product, other)}>Keep this, merge {group.products.length > 2 ? other.name : "the other"}</button>)}</td>
      </tr>)}</tbody></table>
    </section>)}
    {data && !data.candidates.length && <p className="muted">No likely duplicates.</p>}
    {!!data?.merges.length && <section className="card"><h4>Merged</h4><table className="grid compact"><tbody>{data.merges.map((merge) => <tr key={merge.id}><td>{dateTime(merge.createdAt)}</td><td>{merge.mergedName} → {merge.keptName}</td><td><small>{merge.reason}</small></td><td><small>{merge.relinked} moved · {merge.unlinked} kept separate</small></td></tr>)}</tbody></table></section>}
  </>;
}
