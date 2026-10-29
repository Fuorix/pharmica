import { useCallback, useEffect, useState } from "react";
import type { ImportCandidate, ImportJobDetail, ImportJobSummary, ImportKind, ImportRowItem } from "@pharmica/contracts";
import { apiFetch, errorMessage, jsonBody } from "./session";

// Shared by the owner panel and the Pharmica admin panel (assisted setup); keep the two copies identical.

const KINDS: Array<[ImportKind, string, string]> = [
  ["STOCK", "Items and opening stock", "stock"],
  ["CUSTOMERS", "Customers and what they owe", "customers"],
  ["SUPPLIERS", "Suppliers and what the shop owes", "suppliers"]
];
type Filter = "attention" | "ready" | "skipped" | "all";
const statusText: Record<ImportRowItem["status"], string> = { READY: "Ready", NEEDS_REVIEW: "Needs a decision", INVALID: "Left out: fix and re-upload", SKIPPED: "Left out", COMMITTED: "Imported" };

async function download(path: string, fileName: string, onError: (message: string) => void) {
  const response = await apiFetch(path);
  if (!response.ok) return onError(await errorMessage(response, "Download failed"));
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** What a row will become, in words. */
function outcome(row: ImportRowItem): string {
  if (row.status === "COMMITTED") return "Imported";
  switch (row.action) {
    case "MASTER": return `→ ${row.masterName ?? "master-list medicine"}${row.score != null && row.score < 1 ? ` (${Math.round(row.score * 100)}% alike)` : ""}`;
    case "EXISTING": return `→ ${row.productName ?? "existing item"} (already in this branch)`;
    case "NEW": return "→ new item of this shop";
    case "CREATE": return "→ will be added";
    case "SKIP": return "Left out";
    default: return "";
  }
}

function describe(row: ImportRowItem): string {
  const data = row.data ?? {};
  const parts: string[] = [];
  for (const key of ["name", "phone"]) if (data[key]) parts.push(String(data[key]));
  if (data.packs || data.units) parts.push(`${data.packs ?? 0} packs${data.units ? ` + ${data.units}` : ""}`);
  if (data.batchNo) parts.push(`batch ${data.batchNo}`);
  if (data.expiry) parts.push(`exp ${data.expiry}`);
  if (data.balance) parts.push(`balance ${data.balance}`);
  return parts.join(" · ") || Object.values(row.raw).filter(Boolean).slice(0, 4).join(" · ");
}

export function ImportWizard({ branches, organisationId }: { branches: Array<{ id: string; name: string }>; organisationId?: string }) {
  const [jobs, setJobs] = useState<ImportJobSummary[]>([]);
  const [open, setOpen] = useState<ImportJobDetail | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [kind, setKind] = useState<ImportKind>("STOCK");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [mapping, setMapping] = useState<Record<string, string> | null>(null);

  const loadJobs = useCallback(async () => {
    const response = await apiFetch(`/api/v1/imports${organisationId ? `?organisationId=${organisationId}` : ""}`);
    if (response.ok) setJobs((await response.json() as { jobs: ImportJobSummary[] }).jobs);
  }, [organisationId]);
  useEffect(() => { void loadJobs(); }, [loadJobs]);

  const openJob = useCallback(async (id: string, nextFilter: Filter = filter) => {
    const response = await apiFetch(`/api/v1/imports/${id}?filter=${nextFilter}`);
    if (response.ok) { const detail = await response.json() as ImportJobDetail; setOpen(detail); setMapping(detail.job.status === "MAPPING" ? detail.columnMap : null); }
    else setMessage(await errorMessage(response, "Could not open the import"));
  }, [filter]);

  async function run(work: () => Promise<Response>, done: (body: ImportJobDetail & { applied?: number; errors?: Array<{ error: string }> }) => string) {
    setBusy(true);
    try {
      const response = await work();
      if (!response.ok) { setMessage(await errorMessage(response, "That did not work")); return; }
      const body = await response.json() as ImportJobDetail & { applied?: number; errors?: Array<{ error: string }> };
      setOpen(body);
      setMapping(body.job.status === "MAPPING" ? body.columnMap : null);
      setMessage(done(body));
      await loadJobs();
    } catch {
      setMessage("Cannot reach Pharmica. Check the internet connection.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile() {
    if (!file) return setMessage("Choose a file first");
    if (file.size > 8 * 1024 * 1024) return setMessage("Files up to 8 MB; split larger ones");
    const content = await toBase64(file);
    setFilter("all");
    await run(() => apiFetch("/api/v1/imports", { method: "POST", ...jsonBody({ branchId, kind, fileName: file.name, content }) }),
      (body) => body.job.status === "MAPPING" ? "Match the columns below to continue" : `${body.job.rowCount} rows read. ${body.job.counts.needsReview} need a decision, ${body.job.counts.invalid} cannot be imported as they are.`);
  }

  const decide = (row: ImportRowItem, action: string, extra: { masterProductId?: string; productId?: string } = {}) =>
    run(() => apiFetch(`/api/v1/imports/${open!.job.id}`, { method: "PATCH", ...jsonBody({ decisions: [{ rowId: row.id, action, ...extra }] }) }), (body) => body.errors?.length ? body.errors[0].error : `Line ${row.line} decided`);

  if (open) {
    const job = open.job;
    const editable = job.status === "REVIEW";
    return <section className="imp">
      <div className="imp-head">
        <div><button className="link" onClick={() => { setOpen(null); setMessage(""); }}>← All imports</button><h2>{job.kindLabel}</h2><p className="imp-note">{job.fileName} · {job.branchName} · {job.rowCount} rows · by {job.createdBy}{job.committedAt ? ` · imported ${new Date(job.committedAt).toLocaleString("en-PK")} by ${job.committedBy}` : ""}</p></div>
        <div className="imp-actions">
          {(job.counts.invalid > 0 || job.counts.needsReview > 0 || job.counts.skipped > 0) && <button className="secondary" onClick={() => void download(`/api/v1/imports/${job.id}/problems`, `${job.fileName.replace(/\.[^.]+$/, "")}-problems.csv`, setMessage)}>Download rows to fix</button>}
          {editable && <button className="secondary" onClick={() => setMapping(open.columnMap)}>Change columns</button>}
          {(editable || job.status === "MAPPING") && <button className="secondary" onClick={() => { if (window.confirm("Cancel this import? Nothing has been imported yet.")) void run(() => apiFetch(`/api/v1/imports/${job.id}`, { method: "POST", ...jsonBody({ action: "cancel" }) }), () => "Import cancelled"); }}>Cancel import</button>}
          {editable && <button disabled={busy || job.counts.needsReview > 0 || job.counts.ready === 0} onClick={() => { if (window.confirm(`Import ${job.counts.ready} rows into ${job.branchName}? This adds stock and balances in one go.`)) void run(() => apiFetch(`/api/v1/imports/${job.id}`, { method: "POST", ...jsonBody({ action: "commit" }) }), () => "Imported. The counters receive it with their next sync."); }}>{busy ? "Working…" : `Import ${job.counts.ready} rows`}</button>}
        </div>
      </div>
      {message && <p className="imp-message">{message}</p>}
      {job.lastError && job.status !== "COMMITTED" && <p className="imp-message warn">Last attempt failed: {job.lastError}</p>}
      <div className="imp-counts">
        <span className="ready">{job.counts.ready} ready</span><span className="review">{job.counts.needsReview} need a decision</span><span className="invalid">{job.counts.invalid} to fix</span><span>{job.counts.skipped} left out</span>{job.counts.committed > 0 && <span className="ready">{job.counts.committed} imported</span>}
        {job.summary && <span>{Object.entries(job.summary).filter(([, value]) => value).map(([key, value]) => `${key.replace(/([A-Z])/g, " $1").toLowerCase()}: ${value}`).join(" · ")}</span>}
      </div>

      {mapping && <div className="imp-card">
        <h3>Which column holds what?</h3>
        <div className="imp-map">{open.fields.map((field) => <label key={field.key}>{field.label}{field.required ? " *" : ""}
          <select value={mapping[field.key] ?? ""} onChange={(event) => setMapping({ ...mapping, [field.key]: event.target.value })}><option value="">(not in this file)</option>{open.headers.map((header) => <option key={header} value={header}>{header}</option>)}</select>
          {field.hint && <small>{field.hint}</small>}
        </label>)}</div>
        <button disabled={busy} onClick={() => void run(() => apiFetch(`/api/v1/imports/${job.id}`, { method: "PATCH", ...jsonBody({ columnMap: mapping }) }), (body) => `Checked ${body.job.rowCount} rows`)}>Check the rows</button>
        <p className="imp-note">Changing the columns checks every row again and clears earlier decisions.</p>
      </div>}

      {job.status !== "MAPPING" && <>
        <div className="imp-tabs">{([["attention", "Needs a look"], ["ready", "Ready"], ["skipped", "Left out"], ["all", "All rows"]] as Array<[Filter, string]>).map(([key, label]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => { setFilter(key); void openJob(job.id, key); }}>{label}</button>)}</div>
        <table className="imp-table"><thead><tr><th>Line</th><th>In the file</th><th>Becomes</th><th /></tr></thead><tbody>
          {open.rows.map((row) => <tr key={row.id} className={row.status.toLowerCase()}>
            <td>{row.line}</td>
            <td>{describe(row)}{row.problems.map((problem) => <small key={problem}>{problem}</small>)}</td>
            <td><span className={`imp-chip ${row.status.toLowerCase()}`}>{statusText[row.status]}</span><small>{outcome(row)}{row.decidedBy ? ` · decided by ${row.decidedBy}` : ""}</small></td>
            <td className="imp-decide">{editable && row.status !== "COMMITTED" && <>
              {row.candidates.map((candidate: ImportCandidate) => <button key={candidate.id} className="secondary" disabled={busy} onClick={() => void decide(row, "MASTER", { masterProductId: candidate.id })}>{candidate.name} <small>{candidate.company ?? ""} {candidate.packing} · {Math.round(candidate.score * 100)}%</small></button>)}
              {job.kind === "STOCK" && row.status !== "INVALID" && row.action !== "NEW" && row.action !== "EXISTING" && <button className="secondary" disabled={busy} onClick={() => void decide(row, "NEW")}>Add as shop item</button>}
              {row.status !== "SKIPPED" && <button className="secondary" disabled={busy} onClick={() => void decide(row, "SKIP")}>Leave out</button>}
              {row.status === "SKIPPED" && row.action === "SKIP" && job.kind !== "STOCK" && <button className="secondary" disabled={busy} onClick={() => void decide(row, "CREATE")}>Import it</button>}
            </>}</td>
          </tr>)}
        </tbody></table>
        {open.total > open.rows.length && <p className="imp-note">Showing {open.rows.length} of {open.total} rows.</p>}
        {!open.rows.length && <p className="imp-note">Nothing here.</p>}
      </>}
    </section>;
  }

  return <section className="imp">
    <div className="imp-card">
      <h3>Bring in records from the old software</h3>
      <p className="imp-note">Download a template, or upload your own Excel or CSV export; the columns are matched for you. Nothing changes until you press Import, and a file can only be imported once.</p>
      <div className="imp-row">
        <select value={kind} onChange={(event) => setKind(event.target.value as ImportKind)}>{KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        {branches.length > 1 && <select value={branchId} onChange={(event) => setBranchId(event.target.value)}>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>}
        <button className="secondary" onClick={() => void download(`/api/v1/imports/templates/${KINDS.find(([value]) => value === kind)![2]}`, `pharmica-${KINDS.find(([value]) => value === kind)![2]}-template.xlsx`, setMessage)}>Download template</button>
        <input type="file" accept=".xlsx,.csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        <button disabled={busy || !file || !branchId} onClick={() => void uploadFile()}>{busy ? "Reading…" : "Upload and check"}</button>
      </div>
      {message && <p className="imp-message">{message}</p>}
    </div>
    <table className="imp-table"><thead><tr><th>Import</th><th>File</th><th>Rows</th><th>Status</th><th /></tr></thead><tbody>
      {jobs.map((job) => <tr key={job.id}>
        <td>{job.kindLabel}<small>{job.branchName} · {new Date(job.createdAt).toLocaleDateString("en-PK")} · {job.createdBy}</small></td>
        <td>{job.fileName}</td>
        <td>{job.rowCount}<small>{job.status === "COMMITTED" ? `${job.counts.committed} imported` : `${job.counts.ready} ready · ${job.counts.needsReview} to decide · ${job.counts.invalid} to fix`}</small></td>
        <td><span className={`imp-chip ${job.status === "COMMITTED" ? "committed" : job.status === "CANCELLED" ? "skipped" : "needs_review"}`}>{job.status.toLowerCase()}</span></td>
        <td><button className="secondary" onClick={() => { setFilter("all"); void openJob(job.id, "all"); }}>{job.status === "REVIEW" || job.status === "MAPPING" ? "Continue" : "Open"}</button></td>
      </tr>)}
    </tbody></table>
    {!jobs.length && <p className="imp-note">No imports yet.</p>}
  </section>;
}
