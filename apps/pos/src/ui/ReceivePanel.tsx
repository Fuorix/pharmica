import { FormEvent, useMemo, useRef, useState } from "react";
import type { CatalogueProduct, MasterProductSummary, PosStaffMember } from "@pharmica/contracts";
import { NEAR_EXPIRY_DAYS, packingLabel, parseGs1, purchaseTotals } from "@pharmica/domain";
import { OfflineError, type PosEngine, type ReceiveInput } from "../local/engine";
import { searchCatalogue } from "../local/state";
import type { EngineState } from "../local/engine";
import { dateTime, money } from "./format";

type Draft = {
  key: string;
  productId?: string;
  master?: MasterProductSummary;
  name: string;
  /** How a pack is made up, shown so it can be checked against the box. */
  packing: string;
  officialRetailPrice: number | null;
  batchNo: string;
  expiryDate: string;
  quantity: string;
  bonusQuantity: string;
  costPrice: string;
  discount: string;
  retailPrice: string;
  serialNumber?: string;
};

type Choice = { kind: "branch"; product: CatalogueProduct } | { kind: "master"; product: MasterProductSummary };

const looksLikeCode = (text: string) => /^(\]d2|\(01\)|01\d{14}|\d{8}$|\d{12,14}$)/.test(text.trim());
const num = (value: string) => Number(value || 0);

export function ReceivePanel({ engine, state, user }: { engine: PosEngine; state: EngineState; user: PosStaffMember }) {
  const stock = state.stock!;
  const scanRef = useRef<HTMLInputElement>(null);
  const [supplierName, setSupplierName] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [invoiceDiscount, setInvoiceDiscount] = useState("");
  const [lines, setLines] = useState<Draft[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [scan, setScan] = useState("");
  const [choices, setChoices] = useState<Choice[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const totals = useMemo(() => purchaseTotals(lines.map((line) => ({ quantity: num(line.quantity), bonusQuantity: num(line.bonusQuantity), costPrice: num(line.costPrice), discount: num(line.discount) })), num(invoiceDiscount)), [lines, invoiceDiscount]);

  function startDraft(choice: Choice, scanned?: { batchNo?: string; expiryDate?: string; serialNumber?: string }) {
    const product = choice.product;
    const lastPrice = choice.kind === "branch" ? choice.product.sellingPrice : null;
    setDraft({
      key: crypto.randomUUID(),
      ...(choice.kind === "branch" ? { productId: product.id } : { master: choice.product }),
      name: product.name,
      packing: packingLabel({ stripsPerPack: product.unitsPerPack, tabletsPerStrip: product.tabletsPerStrip }, choice.kind === "master" || choice.product.category === "medicine"),
      officialRetailPrice: product.officialRetailPrice,
      batchNo: scanned?.batchNo ?? "",
      expiryDate: scanned?.expiryDate ?? "",
      quantity: "",
      bonusQuantity: "0",
      costPrice: "",
      discount: "0",
      retailPrice: String(lastPrice ?? product.officialRetailPrice ?? ""),
      serialNumber: scanned?.serialNumber
    });
    setChoices([]);
    setScan("");
  }

  async function lookUp(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (choices.length && !looksLikeCode(scan)) return startDraftFromChoice(choices[highlight]);
    const text = scan.trim();
    if (!text) return;

    if (looksLikeCode(text)) {
      const code = parseGs1(text);
      setNotes(code.warnings);
      const barcode = code.barcode;
      const local = barcode ? stock.catalogue.find((product) => product.barcode === barcode || product.barcode === code.gtin) : undefined;
      if (local) return startDraft({ kind: "branch", product: local }, code);
      if (barcode) {
        try {
          const [master] = await engine.searchMaster(barcode);
          if (master) return startDraft({ kind: "master", product: master }, code);
          setNotes([...code.warnings, "This barcode is not on the master list. Search by name and pick the item; the scanned batch and expiry are kept."]);
        } catch (error) {
          setNotes([...code.warnings, error instanceof OfflineError ? "Offline: only items this branch already stocks can be found by barcode. Search by name instead." : "The master list could not be searched."]);
        }
      }
      return;
    }

    const branch: Choice[] = searchCatalogue(stock.catalogue, text, 10).map((product) => ({ kind: "branch", product }));
    let master: Choice[] = [];
    try {
      master = (await engine.searchMaster(text)).map((product) => ({ kind: "master", product }));
    } catch {
      setNotes(["Offline: showing only items this branch already stocks."]);
    }
    setChoices([...branch, ...master]);
    setHighlight(0);
    if (!branch.length && !master.length) setMessage({ tone: "error", text: `Nothing matches "${text}"` });
  }

  function startDraftFromChoice(choice: Choice | undefined) {
    if (choice) startDraft(choice);
  }

  function addLine(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (!draft.batchNo.trim() || !draft.expiryDate || !draft.quantity && !num(draft.bonusQuantity) || draft.costPrice === "" || draft.retailPrice === "") {
      return setMessage({ tone: "error", text: "Fill in batch, expiry, quantity, cost, and retail price" });
    }
    setLines([...lines, draft]);
    setDraft(null);
    setNotes([]);
    setMessage(null);
    window.setTimeout(() => scanRef.current?.focus(), 0);
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const known = state.snapshot?.suppliers.find((supplier) => supplier.name.toLowerCase() === supplierName.trim().toLowerCase());
      const input: ReceiveInput = {
        supplierId: known?.id,
        supplierName,
        invoiceNumber,
        invoiceDate,
        invoiceDiscount: num(invoiceDiscount),
        lines: lines.map((line) => ({ productId: line.productId, master: line.master, batchNo: line.batchNo, expiryDate: line.expiryDate, quantity: num(line.quantity), bonusQuantity: num(line.bonusQuantity), costPrice: num(line.costPrice), discount: num(line.discount), retailPrice: num(line.retailPrice), serialNumber: line.serialNumber }))
      };
      const purchase = await engine.receivePurchase(user, input);
      setLines([]); setInvoiceNumber(""); setInvoiceDiscount(""); setNotes(purchase.warnings);
      setMessage({ tone: "ok", text: `Received ${purchase.totals.paidPacks + purchase.totals.bonusPacks} packs from ${purchase.supplierName} · total ${money(purchase.totals.total)}` });
      scanRef.current?.focus();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not receive" });
    } finally {
      setBusy(false);
    }
  }

  const expiryDays = draft?.expiryDate ? (new Date(draft.expiryDate).getTime() - Date.now()) / 86_400_000 : null;
  const priceDiffers = draft && draft.officialRetailPrice != null && draft.retailPrice !== "" && Math.abs(num(draft.retailPrice) - draft.officialRetailPrice) > 0.005;

  return <section className="work-panel" onKeyDown={(event) => { if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); void save(); } }}>
    <div className="receive-head">
      <label>Supplier<input list="suppliers" value={supplierName} onChange={(event) => setSupplierName(event.target.value)} placeholder="Distributor name" /></label>
      <datalist id="suppliers">{state.snapshot?.suppliers.map((supplier) => <option key={supplier.id} value={supplier.name} />)}</datalist>
      <label>Invoice no.<input value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} /></label>
      <label>Invoice date<input type="date" value={invoiceDate} onChange={(event) => setInvoiceDate(event.target.value)} /></label>
      <label>Invoice discount (PKR)<input inputMode="decimal" value={invoiceDiscount} onChange={(event) => setInvoiceDiscount(event.target.value.replace(/[^\d.]/g, ""))} placeholder="0" /></label>
    </div>

    <form className="search" onSubmit={lookUp}>
      <input ref={scanRef} autoFocus aria-label="Scan or search" value={scan} onChange={(event) => { setScan(event.target.value); setChoices([]); }} placeholder="Scan the 2D code on the pack, or type a name"
        onKeyDown={(event) => {
          if (choices.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setHighlight((current) => Math.max(0, Math.min(choices.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))); }
        }} />
      <b>Enter</b>
    </form>
    {notes.length > 0 && <ul className="scan-notes">{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
    {choices.length > 0 && <div className="results">{choices.map((choice, index) => <button key={`${choice.kind}-${choice.product.id}`} className={index === highlight ? "highlight" : ""} onClick={() => startDraft(choice)}>
      <span className="result-name"><strong>{choice.product.name}</strong>{choice.kind === "master" && <em className="tag">New to this branch</em>}</span>
      <span>{choice.product.generic} · {choice.product.company}</span>
      <span className="result-stock">{choice.kind === "branch" ? `In stock: ${choice.product.stockQuantity}` : `Master price ${choice.product.officialRetailPrice != null ? money(choice.product.officialRetailPrice) : "—"}`}</span>
    </button>)}</div>}

    {draft && <form className="draft" onSubmit={addLine} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setDraft(null); scanRef.current?.focus(); } }}>
      <h3>{draft.name}{draft.master ? " · first time in this branch" : ""}</h3>
      <p className="hint">{draft.packing}. Check this matches the box; the owner can correct it under Catalogue → Packing.</p>
      <div className="draft-grid">
        <label>Batch no.<input autoFocus={!draft.batchNo} value={draft.batchNo} onChange={(event) => setDraft({ ...draft, batchNo: event.target.value.toUpperCase() })} /></label>
        <label>Expiry<input type="date" value={draft.expiryDate} onChange={(event) => setDraft({ ...draft, expiryDate: event.target.value })} /></label>
        <label>Packs<input autoFocus={!!draft.batchNo} inputMode="numeric" value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: event.target.value.replace(/\D/g, "") })} /></label>
        <label>Bonus packs<input inputMode="numeric" value={draft.bonusQuantity} onChange={(event) => setDraft({ ...draft, bonusQuantity: event.target.value.replace(/\D/g, "") })} /></label>
        <label>Cost / pack<input inputMode="decimal" value={draft.costPrice} onChange={(event) => setDraft({ ...draft, costPrice: event.target.value.replace(/[^\d.]/g, "") })} /></label>
        <label>Line discount<input inputMode="decimal" value={draft.discount} onChange={(event) => setDraft({ ...draft, discount: event.target.value.replace(/[^\d.]/g, "") })} /></label>
        <label>Retail / pack (printed)<input inputMode="decimal" value={draft.retailPrice} onChange={(event) => setDraft({ ...draft, retailPrice: event.target.value.replace(/[^\d.]/g, "") })} /></label>
      </div>
      {expiryDays !== null && expiryDays <= 0 && <p className="warning-text">This batch has expired and cannot be received.</p>}
      {expiryDays !== null && expiryDays > 0 && expiryDays < NEAR_EXPIRY_DAYS && <p className="warning-text">Expires within {NEAR_EXPIRY_DAYS} days.</p>}
      {priceDiffers && <p className="warning-text">Printed price differs from the master price {money(draft.officialRetailPrice!)}: it will be reported for review.</p>}
      <div className="row"><button className="primary">Add line <b>Enter</b></button><button type="button" onClick={() => setDraft(null)}>Cancel <b>Esc</b></button></div>
    </form>}

    {message && <p className={`notice-bar ${message.tone}`} role="status">{message.text}</p>}

    <table className="receive-lines">
      <thead><tr><th>Item</th><th>Batch</th><th>Expiry</th><th>Packs</th><th>Bonus</th><th>Cost</th><th>Disc.</th><th>Net</th><th>Real cost / pack</th><th>Retail</th><th /></tr></thead>
      <tbody>{lines.map((line, index) => {
        const priced = "error" in totals ? null : totals.lines[index];
        return <tr key={line.key}>
          <td>{line.name}<small className="line-packing">{line.packing}</small></td><td>{line.batchNo}</td><td>{line.expiryDate}</td><td>{line.quantity || 0}</td><td>{line.bonusQuantity}</td>
          <td>{num(line.costPrice).toFixed(2)}</td><td>{num(line.discount).toFixed(2)}</td><td>{priced ? priced.net.toFixed(2) : "—"}</td><td>{priced ? priced.effectiveCost.toFixed(2) : "—"}</td><td>{num(line.retailPrice).toFixed(2)}</td>
          <td><button className="link" onClick={() => setLines(lines.filter((entry) => entry.key !== line.key))}>remove</button></td>
        </tr>;
      })}</tbody>
    </table>
    {!lines.length && <p className="hint">Scan each pack's 2D code (or search) to add lines. Batch, expiry, and serial fill in from the scan; check them and enter quantity and prices.</p>}

    <div className="receive-totals">
      {"error" in totals ? <p className="warning-text">{lines.length ? totals.error : ""}</p> : <>
        <span>Subtotal <b>{money(totals.subtotal)}</b></span>
        <span>Line discounts <b>−{money(totals.lineDiscount)}</b></span>
        <span>Invoice discount <b>−{money(totals.invoiceDiscount)}</b></span>
        <span>Bonus packs <b>{totals.bonusPacks}</b></span>
        <span className="grand">Payable <b>{money(totals.total)}</b></span>
      </>}
      <button className="checkout" disabled={!lines.length || busy || "error" in totals} onClick={() => void save()}>Receive stock <b>Ctrl+Enter</b></button>
    </div>

    {state.purchases.length > 0 && <details className="recent-purchases"><summary>Received on this counter ({state.purchases.length})</summary>
      {state.purchases.slice(0, 20).map((purchase) => <p key={purchase.id}>{dateTime(purchase.receivedAt)} · {purchase.supplierName}{purchase.invoiceNumber ? ` #${purchase.invoiceNumber}` : ""} · {purchase.lines.length} lines · {money(purchase.totals.total)}{purchase.totals.bonusPacks ? ` · ${purchase.totals.bonusPacks} bonus` : ""}</p>)}
    </details>}
  </section>;
}
