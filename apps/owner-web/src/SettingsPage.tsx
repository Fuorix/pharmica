import { FormEvent, useEffect, useState } from "react";
import type { BranchSettings } from "@pharmica/contracts";
import { pkToday, saveBlob } from "./reportsUi";
import { apiFetch, errorMessage, jsonBody } from "./session";

export type Pharmacy = { name: string; shopCode: string };
export type BranchDetails = { id: string; name: string; address?: string | null; phone?: string | null; settings?: BranchSettings };

const TABLES: Array<[string, string]> = [
  ["sales", "Sales"], ["saleLines", "Sale lines"], ["saleReturns", "Returns"], ["products", "Medicines"], ["batches", "Batches and stock"],
  ["stockMovements", "Stock movements"], ["purchases", "Purchases"], ["purchaseLines", "Purchase lines"], ["suppliers", "Suppliers"],
  ["supplierLedger", "Supplier ledger"], ["customers", "Customers"], ["customerLedger", "Customer credit ledger"], ["expenses", "Expenses"],
  ["shifts", "Shifts"], ["controlledDrugRecords", "Narcotics register"]
];

/** Per-branch receipt text and alert windows, and a full export of the shop's data. */
export function SettingsPage({ branch, pharmacy, onSaved }: { branch: BranchDetails; pharmacy: Pharmacy | null; onSaved: () => void }) {
  const [form, setForm] = useState({ address: "", phone: "", receiptHeader: "", receiptFooter: "", nearExpiryDays: "90", overdueDays: "30", largeDiscountPercent: "10" });
  const [message, setMessage] = useState("");
  const [table, setTable] = useState("sales");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const settings = branch.settings;
    setForm({
      address: branch.address ?? "", phone: branch.phone ?? "",
      receiptHeader: settings?.receiptHeader ?? "", receiptFooter: settings?.receiptFooter ?? "",
      nearExpiryDays: String(settings?.nearExpiryDays ?? 90), overdueDays: String(settings?.overdueDays ?? 30), largeDiscountPercent: String(settings?.largeDiscountPercent ?? 10)
    });
  }, [branch]);
  // Clear the last message only when switching branch; reloading after a save keeps "Saved" on screen.
  useEffect(() => { setMessage(""); }, [branch.id]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const response = await apiFetch("/api/v1/branches", { method: "PATCH", ...jsonBody({
      branchId: branch.id, address: form.address, phone: form.phone,
      settings: { receiptHeader: form.receiptHeader, receiptFooter: form.receiptFooter, nearExpiryDays: Number(form.nearExpiryDays), overdueDays: Number(form.overdueDays), largeDiscountPercent: Number(form.largeDiscountPercent) }
    }) });
    setMessage(response.ok ? "Saved. Counters print the new receipt text after their next sync." : await errorMessage(response, "Could not save"));
    if (response.ok) onSaved();
  }

  async function download(path: string, filename: string) {
    setExporting(true);
    try {
      const response = await apiFetch(path);
      if (!response.ok) return setMessage(await errorMessage(response, "Export failed"));
      saveBlob(await response.blob(), filename);
      setMessage(`Downloaded ${filename}`);
    } catch {
      setMessage("Cannot reach Pharmica. Check the internet connection.");
    } finally {
      setExporting(false);
    }
  }

  const field = (key: keyof typeof form) => ({ value: form[key], onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }) });

  return <>
    <div className="page-heading"><h1>Settings</h1><span className="page-note">{message}</span></div>
    {pharmacy && <article className="panel">
      <div className="panel-heading"><h2>{pharmacy.name}</h2></div>
      <div className="shop-code-box">
        <div><span>Your shop ID</span><strong>{pharmacy.shopCode}</strong></div>
        <p>Every counter is named after it (like <b>{pharmacy.shopCode}-1</b>). Pharmica support may also ask for it.</p>
      </div>
    </article>}
    <article className="panel">
      <div className="panel-heading"><h2>{branch.name}: receipt and alerts</h2></div>
      <form className="settings-form" onSubmit={save}>
        <label>Address on receipts<input maxLength={200} {...field("address")} /></label>
        <label>Phone on receipts<input maxLength={30} {...field("phone")} /></label>
        <label>Extra line under the shop name (e.g. licence or NTN)<input maxLength={300} {...field("receiptHeader")} /></label>
        <label>Receipt footer<input maxLength={300} {...field("receiptFooter")} /></label>
        <label>Near expiry warning (days before expiry)<input type="number" min={7} max={365} required {...field("nearExpiryDays")} /></label>
        <label>Credit overdue after (days)<input type="number" min={1} max={365} required {...field("overdueDays")} /></label>
        <label>Alert on discounts of at least (% of bill)<input type="number" min={1} max={100} required {...field("largeDiscountPercent")} /></label>
        <div><button>Save settings</button></div>
      </form>
    </article>

    <article className="panel settings-export">
      <div className="panel-heading"><h2>Export your data</h2><span>Your data belongs to you. Passwords, PINs, and device keys are never included.</span></div>
      <div className="filter-bar">
        <button disabled={exporting} onClick={() => void download("/api/v1/export", `pharmica-export-${pkToday()}.json`)}>Download everything (JSON)</button>
        <select value={table} onChange={(event) => setTable(event.target.value)}>{TABLES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <button className="secondary" disabled={exporting} onClick={() => void download(`/api/v1/export?entity=${table}&format=csv`, `pharmica-${table}-${pkToday()}.csv`)}>Download as CSV</button>
      </div>
    </article>
  </>;
}
