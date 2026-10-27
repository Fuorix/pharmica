import { FormEvent, useMemo, useState } from "react";
import type { PaymentMethod } from "@pharmica/contracts";
import type { LocalReturn, LocalSale } from "../local/types";
import { Dialog } from "./Dialog";
import { dateTime, money, unitLabel } from "./format";

type Mode = { name: "list" } | { name: "detail"; saleId: string } | { name: "void"; saleId: string } | { name: "return"; saleId: string; exchange: boolean };

const returnedOf = (sale: LocalSale, lineId: string) => sale.returns.reduce((sum, item) => sum + (item.lines.find((entry) => entry.saleLineId === lineId)?.quantity ?? 0), 0);

export function SalesDialog({ sales, currentShiftId, onClose, onReprint, onVoid, onReturn }: {
  sales: LocalSale[]; currentShiftId: string | undefined; onClose: () => void;
  onReprint: (sale: LocalSale) => void;
  onVoid: (sale: LocalSale, reason: string) => Promise<void>;
  onReturn: (sale: LocalSale, lines: Array<{ saleLineId: string; quantity: number }>, reason: string, method: PaymentMethod, exchange: boolean) => Promise<LocalReturn | void>;
}) {
  const [mode, setMode] = useState<Mode>({ name: "list" });
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [reason, setReason] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [error, setError] = useState("");

  const matches = useMemo(() => {
    const text = query.trim().toUpperCase();
    return sales.filter((sale) => !text || sale.receiptNo.includes(text) || sale.customerName?.toUpperCase().includes(text)).slice(0, 40);
  }, [sales, query]);
  const sale = "saleId" in mode ? sales.find((candidate) => candidate.id === mode.saleId) : undefined;

  async function run(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Something went wrong");
    }
  }

  if (mode.name === "list") {
    return <Dialog title="Recent sales on this counter" onClose={onClose} wide>
      <div className="stack">
        <input autoFocus placeholder="Receipt number or customer" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setIndex((current) => Math.min(matches.length - 1, current + 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setIndex((current) => Math.max(0, current - 1)); }
          if (event.key === "Enter" && matches[index]) { event.preventDefault(); setMode({ name: "detail", saleId: matches[index].id }); }
        }} />
        <div className="pick-list">{matches.map((item, position) => <button key={item.id} className={position === index ? "highlight" : ""} onClick={() => setMode({ name: "detail", saleId: item.id })}>
          <strong>{item.receiptNo}</strong><span>{dateTime(item.createdAt)} · {item.userName}{item.customerName ? ` · ${item.customerName}` : ""}</span>
          <span>{money(item.total)} · {item.status}{item.returns.length ? ` · ${item.returns.length} return(s)` : ""}</span>
        </button>)}</div>
        {!matches.length && <p className="muted">No sales yet.</p>}
      </div>
    </Dialog>;
  }

  if (!sale) return null;
  const canVoid = sale.status === "completed" && !sale.returns.length && sale.shiftId === currentShiftId;
  const canReturn = sale.status !== "voided" && sale.lines.some((line) => returnedOf(sale, line.lineId) < line.quantity);

  if (mode.name === "void") {
    return <Dialog title={`Void receipt ${sale.receiptNo}`} onClose={() => setMode({ name: "detail", saleId: sale.id })}>
      <form className="stack" onSubmit={(event: FormEvent) => { event.preventDefault(); void run(() => onVoid(sale, reason)); }}>
        <p className="muted">All {sale.lines.length} line(s) go back into stock{sale.paymentMethod === "credit" ? " and the customer's credit is reversed" : ""}. Give back {money(sale.total)}. The owner sees every void.</p>
        <input autoFocus required placeholder="Reason (required)" value={reason} onChange={(event) => setReason(event.target.value)} />
        {error && <p className="warning-text">{error}</p>}
        <button className="primary danger" disabled={!reason.trim()}>Void sale <b>Enter</b></button>
      </form>
    </Dialog>;
  }

  if (mode.name === "return") {
    const chosen = sale.lines.map((line) => ({ saleLineId: line.lineId, quantity: quantities[line.lineId] ?? 0 })).filter((line) => line.quantity > 0);
    return <Dialog title={`${mode.exchange ? "Exchange" : "Return"} from ${sale.receiptNo}`} onClose={() => setMode({ name: "detail", saleId: sale.id })} wide>
      <form className="stack" onSubmit={(event: FormEvent) => { event.preventDefault(); void run(() => onReturn(sale, chosen, reason, method, mode.exchange)); }}>
        <table className="return-table"><thead><tr><th>Item</th><th>Sold</th><th>Returned</th><th>Return now</th></tr></thead><tbody>
          {sale.lines.map((line, position) => {
            const left = line.quantity - returnedOf(sale, line.lineId);
            return <tr key={line.lineId}>
              <td>{line.name}<small>{line.unit} · batch {line.batchNo}</small></td><td>{line.quantity}</td><td>{line.quantity - left}</td>
              <td><input autoFocus={position === 0} type="number" min={0} max={left} disabled={!left} value={quantities[line.lineId] ?? 0} onChange={(event) => setQuantities({ ...quantities, [line.lineId]: Math.max(0, Math.min(left, Math.floor(Number(event.target.value) || 0))) })} /></td>
            </tr>;
          })}
        </tbody></table>
        <input required placeholder="Reason (required)" value={reason} onChange={(event) => setReason(event.target.value)} />
        {sale.paymentMethod === "credit"
          ? <p className="muted">Credit sale: the refund reduces what {sale.customerName} owes.</p>
          : !mode.exchange && <div className="segmented">{(["cash", "card"] as const).map((item) => <button type="button" key={item} className={method === item ? "active" : ""} onClick={() => setMethod(item)}>Refund by {item}</button>)}</div>}
        {mode.exchange && <p className="muted">The refund becomes credit on the next bill. Add the replacement items after this.</p>}
        {error && <p className="warning-text">{error}</p>}
        <button className="primary" disabled={!chosen.length || !reason.trim()}>{mode.exchange ? "Return and start exchange" : "Complete return"} <b>Enter</b></button>
      </form>
    </Dialog>;
  }

  return <Dialog title={`Receipt ${sale.receiptNo}`} onClose={() => setMode({ name: "list" })} wide>
    <div className="stack" tabIndex={-1} ref={(element) => element?.focus()} onKeyDown={(event) => {
      const key = event.key.toLowerCase();
      if (key === "p") { event.preventDefault(); onReprint(sale); }
      if (key === "v" && canVoid) { event.preventDefault(); setReason(""); setMode({ name: "void", saleId: sale.id }); }
      if (key === "r" && canReturn) { event.preventDefault(); setReason(""); setQuantities({}); setMode({ name: "return", saleId: sale.id, exchange: false }); }
      if (key === "x" && canReturn && sale.paymentMethod !== "credit") { event.preventDefault(); setReason(""); setQuantities({}); setMode({ name: "return", saleId: sale.id, exchange: true }); }
    }}>
      <p className="muted">{dateTime(sale.createdAt)} · {sale.userName} · {sale.paymentMethod}{sale.customerName ? ` · ${sale.customerName}` : ""} · <b>{sale.status}</b>{sale.voidReason ? ` (${sale.voidReason})` : ""}</p>
      <table className="return-table"><tbody>{sale.lines.map((line) => <tr key={line.lineId}><td>{line.name}<small>batch {line.batchNo}</small></td><td>{unitLabel(line.unit, line.quantity, line.pieces)}</td><td>{money(line.lineTotal)}</td></tr>)}</tbody></table>
      <p><b>Total {money(sale.total)}</b>{sale.discount ? ` after ${money(sale.discount)} discount` : ""}</p>
      {sale.returns.map((item) => <p key={item.returnId} className="muted">Returned {dateTime(item.at)}: {money(item.amount)} by {item.method} — {item.reason}</p>)}
      <div className="row">
        <button onClick={() => onReprint(sale)}>Reprint <b>P</b></button>
        <button disabled={!canVoid} title={canVoid ? "" : "Only sales from this shift with no returns"} onClick={() => { setReason(""); setMode({ name: "void", saleId: sale.id }); }}>Void <b>V</b></button>
        <button disabled={!canReturn} onClick={() => { setReason(""); setQuantities({}); setMode({ name: "return", saleId: sale.id, exchange: false }); }}>Return <b>R</b></button>
        <button disabled={!canReturn || sale.paymentMethod === "credit"} onClick={() => { setReason(""); setQuantities({}); setMode({ name: "return", saleId: sale.id, exchange: true }); }}>Exchange <b>X</b></button>
      </div>
    </div>
  </Dialog>;
}
