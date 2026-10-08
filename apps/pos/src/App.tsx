import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogueProduct, PaymentMethod, Prescription, SaleUnit } from "@pharmica/contracts";
import { billTotals, discountWithinLimit, priceCart, type CartItem } from "@pharmica/domain";
import { PosError } from "./local/engine";
import { searchCatalogue, substitutesFor } from "./local/state";
import type { LocalSale } from "./local/types";
import { usePosSession, useEngineState } from "./session";
import { CustomerDialog, DiscountDialog, HeldDialog, HelpDialog, PaymentDialog, PrescriptionDialog, SubstitutesDialog, SyncDialog } from "./ui/dialogs";
import { money, stockLabel, unitLabel } from "./ui/format";
import { Printable, printNow, type PrintJob } from "./ui/Printable";
import { SalesDialog } from "./ui/SalesDialog";
import { ReceivePanel } from "./ui/ReceivePanel";
import { ShiftDialog } from "./ui/ShiftDialog";
import { StockPanel, stockRows } from "./ui/StockPanel";

type Mode = "billing" | "receive" | "stock";
const MODES: Array<{ value: Mode; label: string; key: string }> = [{ value: "billing", label: "Billing", key: "1" }, { value: "receive", label: "Receive stock", key: "2" }, { value: "stock", label: "Stock", key: "3" }];

type DialogState =
  | null
  | { kind: "help" | "payment" | "customer" | "held" | "sales" | "shift" | "sync" | "prescription" }
  | { kind: "discount"; target: "item" | "bill" }
  | { kind: "substitutes"; product: CatalogueProduct };

type Notice = { tone: "ok" | "error" | "info"; text: string } | null;

const PAYMENT_CYCLE: PaymentMethod[] = ["cash", "card", "credit"];
const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong";

export function App() {
  const { user, device, engine, lock } = usePosSession();
  const state = useEngineState(engine);
  const stock = state.stock!;
  const searchRef = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<CartItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [billDiscount, setBillDiscount] = useState(0);
  const [exchangeCredit, setExchangeCredit] = useState(0);
  const [prescription, setPrescription] = useState<Prescription | undefined>();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [printJob, setPrintJob] = useState<{ job: PrintJob; at: number } | null>(null);
  const [lastSale, setLastSale] = useState<LocalSale | null>(null);
  const [mode, setMode] = useState<Mode>("billing");
  const alerts = useMemo(() => stockRows(state).filter((row) => row.status.lowStock || row.status.nearExpiry > 0 || row.status.expired > 0).length, [state]);

  const catalogueById = useMemo(() => new Map(stock.catalogue.map((product) => [product.id, product])), [stock.catalogue]);
  const results = useMemo(() => searchCatalogue(stock.catalogue, query), [stock.catalogue, query]);
  const quote = useMemo(() => {
    const cart = priceCart(items, stock.products, stock.batches, new Date());
    return { cart, totals: billTotals(cart, billDiscount) };
  }, [items, billDiscount, stock]);
  const totals = "error" in quote.totals ? null : quote.totals;
  const customer = customerId ? stock.customers.find((candidate) => candidate.id === customerId) : undefined;
  const selected = items.find((item) => item.key === selectedKey) ?? items[items.length - 1];

  const say = (tone: "ok" | "error" | "info", text: string) => setNotice({ tone, text });
  // Deferred so it runs after React renders; it never pulls focus out of a dialog opened in the meantime (F10 straight after a scan).
  const focusSearch = () => window.setTimeout(() => { if (!document.activeElement?.closest("[role=dialog]")) searchRef.current?.focus(); }, 0);
  const closeDialog = useCallback(() => { setDialog(null); focusSearch(); }, []);
  const print = (job: PrintJob) => setPrintJob({ job, at: Date.now() });

  useEffect(() => { if (printJob) printNow(state.settings.paperWidth); }, [printJob, state.settings.paperWidth]);
  useEffect(() => { setHighlight(0); }, [query]);
  // A counter deactivated by the owner must stop selling at once.
  useEffect(() => { if (state.deviceRevoked) lock(); }, [state.deviceRevoked, lock]);

  function clearBill() {
    setItems([]); setSelectedKey(null); setCustomerId(undefined); setPaymentMethod("cash"); setBillDiscount(0); setExchangeCredit(0); setPrescription(undefined);
  }

  function addProduct(product: CatalogueProduct, unit: SaleUnit = "pack") {
    if (product.sellingPrice == null) {
      setQuery("");
      return setDialog({ kind: "substitutes", product });
    }
    const existing = items.find((item) => item.productId === product.id && item.unit === unit);
    if (existing) {
      setItems(items.map((item) => item === existing ? { ...item, quantity: item.quantity + 1 } : item));
      setSelectedKey(existing.key);
    } else {
      const key = crypto.randomUUID();
      setItems([...items, { key, productId: product.id, unit, quantity: 1, discount: 0 }]);
      setSelectedKey(key);
    }
    if (product.isControlled) say("info", `${product.name} is a controlled drug: record the prescription in the register.`);
    else if (product.isPrescriptionOnly) say("info", `${product.name} needs a prescription.`);
    setQuery("");
    focusSearch();
  }

  function updateSelected(change: (item: CartItem) => CartItem | null) {
    if (!selected) return;
    const next = change(selected);
    if (next) setItems(items.map((item) => item.key === selected.key ? next : item));
  }

  function removeSelected() {
    if (!selected) return;
    const product = catalogueById.get(selected.productId);
    setItems(items.filter((item) => item.key !== selected.key));
    setSelectedKey(null);
    void engine.audit(user, "line_deleted", "cart", { product: product?.name, quantity: selected.quantity, unit: selected.unit });
  }

  function cycleUnit() {
    updateSelected((item) => {
      const units = catalogueById.get(item.productId)?.sellableUnits ?? ["pack"];
      return { ...item, unit: units[(units.indexOf(item.unit) + 1) % units.length], discount: 0 };
    });
  }

  function openPayment() {
    if (!state.shift) return say("error", "Open a shift first");
    if (!items.length) return say("error", "Add an item before taking payment");
    if (quote.cart.problems.length) return say("error", quote.cart.problems[0].message);
    if (!totals) return say("error", "error" in quote.totals ? quote.totals.error : "Check the bill");
    // A controlled drug cannot be sold until the prescription is entered for the narcotics register.
    if (engine.needsPrescription(items) && !prescription) return setDialog({ kind: "prescription" });
    setDialog({ kind: "payment" });
  }

  async function completeSale(cashReceived?: number) {
    try {
      const sale = await engine.completeSale({ user, items, billDiscount, paymentMethod, customerId, cashReceived, prescription });
      setLastSale(sale);
      clearBill();
      setDialog(null);
      say("ok", `Receipt ${sale.receiptNo} · ${money(sale.total)}${sale.change ? ` · change ${money(sale.change)}` : ""} · Ctrl+P to print`);
      focusSearch();
    } catch (error) {
      say("error", errorText(error));
    }
  }

  async function holdBill() {
    if (!items.length) return say("error", "Nothing to hold");
    await engine.holdBill({ label: customer?.name ?? `Bill at ${new Date().toLocaleTimeString("en-PK", { timeStyle: "short" })}`, userId: user.id, items, customerId, billDiscount, paymentMethod });
    clearBill();
    say("ok", "Bill held. F6 to resume");
  }

  function lockCounter() {
    if (items.length) void holdBill();
    lock();
  }

  // Re-bound on every render so shortcuts always act on the current bill.
  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  function handleKey(event: KeyboardEvent) {
    if (dialog || !state.shift) return;
    const switchTo = event.ctrlKey ? MODES.find((entry) => entry.key === event.key) : undefined;
    if (switchTo) { event.preventDefault(); setMode(switchTo.value); if (switchTo.value === "billing") focusSearch(); return; }
    if (event.key === "F12") { event.preventDefault(); lockCounter(); return; }
    if (mode !== "billing") return;
    const inSearch = document.activeElement === searchRef.current;
    const key = event.key;
    const shortcut = (action: () => void) => { event.preventDefault(); action(); };

    if (key === "F1") return shortcut(() => setDialog({ kind: "help" }));
    if (key === "F2") return shortcut(() => searchRef.current?.focus());
    if (key === "F3") return shortcut(() => setDialog({ kind: "customer" }));
    if (key === "F4") return shortcut(cycleUnit);
    if (key === "F5") return shortcut(() => void holdBill());
    if (key === "F6") return shortcut(() => items.length ? say("error", "Hold or finish the current bill first") : setDialog({ kind: "held" }));
    if (key === "F7") return shortcut(() => selected ? setDialog({ kind: "discount", target: "item" }) : say("error", "Select a line first"));
    if (key === "F8") return shortcut(() => items.length ? setDialog({ kind: "discount", target: "bill" }) : say("error", "The bill is empty"));
    if (key === "F9") return shortcut(() => setPaymentMethod(PAYMENT_CYCLE[(PAYMENT_CYCLE.indexOf(paymentMethod) + 1) % PAYMENT_CYCLE.length]));
    if (key === "F10") return shortcut(openPayment);
    if (key === "F11") return shortcut(() => setDialog({ kind: "shift" }));
    if (key === "F12") return shortcut(lockCounter);
    if (event.ctrlKey && key.toLowerCase() === "r") return shortcut(() => setDialog({ kind: "sales" }));
    if (event.ctrlKey && key.toLowerCase() === "p") return shortcut(() => lastSale ? print({ kind: "receipt", sale: lastSale }) : say("error", "No sale to reprint yet"));
    if (event.ctrlKey && key.toLowerCase() === "d") return shortcut(() => { void engine.audit(user, "cash_drawer_opened", "drawer"); say("info", "Cash drawer opening recorded"); });
    if (event.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
      return shortcut(() => {
        if (!items.length) return;
        const position = items.findIndex((item) => item.key === selected?.key);
        setSelectedKey(items[Math.max(0, Math.min(items.length - 1, position + (key === "ArrowUp" ? -1 : 1)))].key);
      });
    }
    if (inSearch && query && results.length && (key === "ArrowDown" || key === "ArrowUp")) {
      return shortcut(() => setHighlight((current) => Math.max(0, Math.min(results.length - 1, current + (key === "ArrowDown" ? 1 : -1)))));
    }
    if (inSearch && key === "Enter" && query.trim()) {
      return shortcut(() => {
        const exact = stock.catalogue.find((product) => product.barcode === query.trim());
        const pick = exact ?? results[highlight];
        if (pick) addProduct(pick);
        else say("error", `Nothing matches "${query.trim()}"`);
      });
    }
    if (!query && (key === "+" || key === "=")) return shortcut(() => updateSelected((item) => ({ ...item, quantity: item.quantity + 1 })));
    if (!query && key === "-") return shortcut(() => updateSelected((item) => item.quantity > 1 ? { ...item, quantity: item.quantity - 1 } : item));
    if (!query && key === "Delete") return shortcut(removeSelected);
    if (key === "Escape") return shortcut(() => { setQuery(""); setNotice(null); });
  }

  const receipt = state.snapshot?.receipt;
  const header = { organisationName: state.snapshot?.organisationName ?? "Pharmacy", branchName: device.branchName, deviceName: device.name, receiptHeader: receipt?.header, receiptFooter: receipt?.footer, address: receipt?.address, phone: receipt?.phone };
  const status = state.sync;

  return <main className="pos-shell">
    <header className="pos-header">
      <div><p className="eyebrow">PHARMICA POS · {device.branchName.toUpperCase()}</p><h1>{device.name}</h1></div>
      {state.shift && <nav className="mode-tabs" aria-label="Mode">{MODES.map((entry) => <button key={entry.value} className={mode === entry.value ? "active" : ""} onClick={() => { setMode(entry.value); if (entry.value === "billing") focusSearch(); }}>
        {entry.label}{entry.value === "stock" && alerts > 0 ? <span className="badge">{alerts}</span> : null} <b>Ctrl+{entry.key}</b>
      </button>)}</nav>}
      <div className="header-actions">
        <button className={`sync-pill ${status.online ? "online" : "offline"}`} onClick={() => setDialog({ kind: "sync" })} title="Sync and settings">
          <span />{status.online ? "Online" : "Offline"}{status.pending ? ` · ${status.pending} to upload` : ""}{status.failed ? ` · ${status.failed} rejected` : ""}
        </button>
        <div className="signed-in">{user.name} · {user.role}</div>
        <button className="ghost" onClick={() => setDialog({ kind: "help" })}>Help <b>F1</b></button>
        <button className="ghost" onClick={lockCounter}>Lock <b>F12</b></button>
      </div>
    </header>

    {state.shift && mode === "receive" && <ReceivePanel engine={engine} state={state} user={user} />}
    {state.shift && mode === "stock" && <StockPanel engine={engine} state={state} user={user} />}
    {!state.shift ? <OpenShift onOpen={async (cash) => { await engine.openShift(user, cash); say("ok", "Shift opened. Start billing"); focusSearch(); }} /> : mode === "billing" && <>
      {notice && <p className={`notice-bar ${notice.tone}`} role="status">{notice.text}</p>}
      <section className="pos-grid">
        <section className="sale-panel">
          <div className="search">
            <input ref={searchRef} autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search medicine, salt, company, or scan a barcode" aria-label="Search" />
            <b>F2</b>
          </div>
          {query && <div className="results" role="listbox">
            {results.map((product, index) => <button key={product.id} role="option" aria-selected={index === highlight} className={`${index === highlight ? "highlight" : ""} ${product.sellingPrice == null ? "out-of-stock" : ""}`} onMouseEnter={() => setHighlight(index)} onClick={() => addProduct(product)}>
              <span className="result-name"><strong>{product.name}</strong>{product.isControlled ? <em className="tag controlled">Controlled</em> : product.isPrescriptionOnly ? <em className="tag">Rx</em> : null}</span>
              <span>{product.generic ?? product.category} · {product.company ?? ""}</span>
              <span className="result-stock">{product.sellingPrice == null ? "Out of stock · Enter for substitutes" : `${money(product.sellingPrice)} · ${stockLabel(product.stockQuantity, product.unitsPerPack, product.tabletsPerStrip)}${product.rackLocation ? ` · Rack ${product.rackLocation}` : ""}`}</span>
            </button>)}
            {!results.length && <p className="hint">No match for "{query}".</p>}
          </div>}
          {!query && <div className="idle">
            <p className="hint">Type a brand, salt (e.g. paracetamol), company, or scan. <kbd>Enter</kbd> adds the highlighted item.</p>
            <div className="quick-grid">
              <button onClick={() => setDialog({ kind: "customer" })}>Customer <b>F3</b></button>
              <button onClick={() => void holdBill()}>Hold bill <b>F5</b></button>
              <button onClick={() => items.length ? say("error", "Hold or finish the current bill first") : setDialog({ kind: "held" })}>Held bills ({state.held.length}) <b>F6</b></button>
              <button onClick={() => setDialog({ kind: "sales" })}>Recent sales <b>Ctrl+R</b></button>
              <button onClick={() => setDialog({ kind: "shift" })}>Shift / end of day <b>F11</b></button>
              <button onClick={() => lastSale ? print({ kind: "receipt", sale: lastSale }) : say("error", "No sale to reprint yet")}>Reprint last <b>Ctrl+P</b></button>
            </div>
          </div>}
        </section>

        <aside className="cart">
          <div className="cart-title"><h2>Current bill</h2><span>{items.length} item{items.length === 1 ? "" : "s"}</span></div>
          {prescription && engine.needsPrescription(items) && <p className="customer-chip">Rx: {prescription.patientName} · {prescription.doctorName} <button className="link" onClick={() => setDialog({ kind: "prescription" })}>edit</button></p>}
          {customer && <p className="customer-chip">{customer.name}{customer.balance > 0 ? ` · owes ${money(customer.balance)}` : ""} <button className="link" onClick={() => setCustomerId(undefined)}>remove</button></p>}
          <div className="cart-lines">
            {items.map((item) => {
              const product = catalogueById.get(item.productId);
              const lines = quote.cart.lines.filter((line) => line.itemKey === item.key);
              const problem = quote.cart.problems.find((entry) => entry.itemKey === item.key);
              const lineTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
              return <div key={item.key} className={`cart-row ${item.key === selected?.key ? "selected" : ""} ${problem ? "problem" : ""}`} onClick={() => setSelectedKey(item.key)}>
                <div>
                  <strong>{product?.name ?? "Unknown item"}</strong>
                  <span className="row-controls">
                    <select aria-label="Unit" value={item.unit} onChange={(event) => setItems(items.map((entry) => entry.key === item.key ? { ...entry, unit: event.target.value as SaleUnit, discount: 0 } : entry))}>{(product?.sellableUnits ?? ["pack"]).map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select>
                    <input aria-label={`Quantity for ${product?.name}`} type="number" min={1} value={item.quantity} onChange={(event) => setItems(items.map((entry) => entry.key === item.key ? { ...entry, quantity: Math.max(1, Math.floor(Number(event.target.value) || 1)) } : entry))} />
                  </span>
                  {problem ? <small className="warning-text">{problem.message}</small> : <small>{lines.map((line) => `${unitLabel(line.unit, line.quantity)} @ ${line.unitPrice.toFixed(2)} (B:${line.batchNo})`).join(" + ")}{item.discount ? ` · −${item.discount.toFixed(2)}` : ""}</small>}
                </div>
                <b>{problem ? "—" : money(lineTotal)}</b>
              </div>;
            })}
            {!items.length && <p className="hint">Scan or search to add items.</p>}
          </div>
          <div className="totals">
            <span>Subtotal</span><strong>{money(quote.cart.subtotal)}</strong>
            {totals && totals.discount > 0 && <><span>Discount</span><strong>−{money(totals.discount)}</strong></>}
            {exchangeCredit > 0 && <><span>Exchange credit</span><strong>−{money(exchangeCredit)}</strong></>}
            <span className="grand">Total</span><strong className="grand">{money(totals?.total ?? quote.cart.subtotal)}</strong>
          </div>
          <div className="segmented small">{PAYMENT_CYCLE.map((method) => <button key={method} className={paymentMethod === method ? "active" : ""} onClick={() => setPaymentMethod(method)}>{method === "credit" ? "Credit" : method[0].toUpperCase() + method.slice(1)}</button>)}</div>
          <button className="checkout" disabled={!items.length} onClick={openPayment}>Take payment <b>F10</b></button>
        </aside>
      </section>
    </>}

    {dialog?.kind === "help" && <HelpDialog onClose={closeDialog} />}
    {dialog?.kind === "payment" && totals && <PaymentDialog totals={totals} method={paymentMethod} onMethod={setPaymentMethod} customer={customer} exchangeCredit={exchangeCredit} onClose={closeDialog} onConfirm={completeSale} />}
    {dialog?.kind === "customer" && <CustomerDialog customers={stock.customers} selectedId={customerId} onClose={closeDialog}
      onSelect={(chosen) => { setCustomerId(chosen?.id); if (chosen) say("info", `Customer: ${chosen.name}`); closeDialog(); }}
      onCreate={(input) => engine.createCustomer(user, input)}
      onReceivePayment={async (chosen, amount, method) => {
        const payment = await engine.receivePayment(user, { customerId: chosen.id, amount, method });
        closeDialog(); print({ kind: "payment", payment });
        say("ok", `Received ${money(amount)} from ${chosen.name}. Still owed: ${money(payment.balanceAfter)}`);
      }} />}
    {dialog?.kind === "prescription" && <PrescriptionDialog drugs={items.map((item) => catalogueById.get(item.productId)).filter((product) => product?.isControlled).map((product) => product!.name)} current={prescription} onClose={closeDialog}
      onSave={(entered) => { setPrescription(entered); setDialog({ kind: "payment" }); }} />}
    {dialog?.kind === "discount" && (() => {
      const isItem = dialog.target === "item";
      const itemGross = selected ? quote.cart.lines.filter((line) => line.itemKey === selected.key).reduce((sum, line) => sum + line.gross, 0) : 0;
      const base = isItem ? itemGross : Math.max(0, quote.cart.subtotal - quote.cart.itemDiscount);
      const limit = user.maxDiscountPercent;
      return <DiscountDialog title={isItem ? `Discount on ${catalogueById.get(selected!.productId)?.name}` : "Discount on the whole bill"} base={base} current={isItem ? selected?.discount ?? 0 : billDiscount}
        limitNote={limit == null ? "" : `Your limit: ${limit}% of the bill.`} onClose={closeDialog}
        onApply={(amount) => {
          const itemDiscount = isItem ? quote.cart.itemDiscount - (selected?.discount ?? 0) + amount : quote.cart.itemDiscount;
          const total = itemDiscount + (isItem ? billDiscount : amount);
          if (!discountWithinLimit(quote.cart.subtotal, total, limit)) return `That is over your ${limit}% limit. Ask the owner to sign in for a bigger discount.`;
          if (isItem) updateSelected((item) => ({ ...item, discount: amount })); else setBillDiscount(amount);
          closeDialog();
          return null;
        }} />;
    })()}
    {dialog?.kind === "held" && <HeldDialog held={state.held} names={new Map(stock.catalogue.map((product) => [product.id, product.name]))} onClose={closeDialog} onResume={async (bill) => {
      await engine.takeHeldBill(bill.id);
      setItems(bill.items); setCustomerId(bill.customerId); setBillDiscount(bill.billDiscount); setPaymentMethod(bill.paymentMethod); setSelectedKey(null);
      closeDialog(); say("ok", `Resumed ${bill.label}`);
    }} />}
    {dialog?.kind === "substitutes" && <SubstitutesDialog product={dialog.product} substitutes={substitutesFor(dialog.product, stock.catalogue)} onClose={closeDialog} onPick={(product) => { setDialog(null); addProduct(product); }} />}
    {dialog?.kind === "sales" && <SalesDialog sales={state.sales} currentShiftId={state.shift?.id} onClose={closeDialog}
      onReprint={(sale) => print({ kind: "receipt", sale })}
      onVoid={async (sale, reason) => {
        const voided = await engine.voidSale(user, sale.id, reason);
        closeDialog(); say("ok", `Receipt ${sale.receiptNo} voided. Give back ${money(sale.total)}.`);
        print({ kind: "receipt", sale: voided });
      }}
      onReturn={async (sale, lines, reason, method, exchange) => {
        const { sale: updated, saleReturn } = await engine.returnItems(user, sale.id, lines, reason, exchange ? "cash" : method);
        closeDialog();
        print({ kind: "return", sale: updated, saleReturn });
        if (exchange) { setExchangeCredit(saleReturn.amount); say("info", `Exchange: ${money(saleReturn.amount)} credit. Add the replacement items.`); }
        else say("ok", saleReturn.method === "credit" ? `Returned. ${money(saleReturn.amount)} taken off ${sale.customerName}'s account.` : `Returned. Refund ${money(saleReturn.amount)} by ${saleReturn.method}.`);
      }} />}
    {dialog?.kind === "shift" && state.shift && <ShiftDialog shift={state.shift} report={engine.shiftReport()!} onReport={(counted) => engine.shiftReport(counted)} onClose={closeDialog}
      onPrintInterim={() => print({ kind: "shift", shift: state.shift!, report: engine.shiftReport()! })}
      onCloseShift={async (counted) => {
        if (items.length) throw new PosError("Finish or hold the current bill before closing the shift");
        const closed = await engine.closeShift(user, counted);
        setDialog(null); print({ kind: "shift", shift: closed, report: closed.report! });
        say("ok", "Shift closed. End-of-day report printed.");
      }} />}
    {dialog?.kind === "sync" && <SyncDialog status={status} outbox={state.outbox} paperWidth={state.settings.paperWidth} onPaperWidth={(width) => void engine.saveSettings({ ...state.settings, paperWidth: width })}
      onRetry={() => void engine.retryFailed()} onSyncNow={() => void engine.syncNow()} onClose={closeDialog}
      onExport={() => {
        // A JSON file support can read; prescription details and PINs are left out.
        const blob = new Blob([JSON.stringify(engine.exportDiagnostics(), null, 2)], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `pharmica-diagnostics-${device.name.replace(/\W+/g, "-")}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
      }} />}

    <div className="print-area" aria-hidden="true"><Printable job={printJob?.job ?? null} header={header} /></div>
  </main>;
}

function OpenShift({ onOpen }: { onOpen: (openingCash: number) => Promise<void> }) {
  const [cash, setCash] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await onOpen(Number(cash || 0));
    } catch (problem) {
      setError(errorText(problem));
    }
  }
  return <form className="open-shift" onSubmit={submit}>
    <h2>Open the counter</h2>
    <p className="hint">Count the cash in the drawer to start the shift. Sales, voids, and returns are totalled against it at closing.</p>
    <label>Opening cash (PKR)<input autoFocus inputMode="decimal" value={cash} onChange={(event) => setCash(event.target.value.replace(/[^\d.]/g, ""))} placeholder="0" /></label>
    {error && <p className="warning-text">{error}</p>}
    <button className="checkout">Open shift <b>Enter</b></button>
  </form>;
}
