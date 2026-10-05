import { FormEvent, useState } from "react";
import type { ShiftReport } from "@pharmica/domain";
import type { LocalShift } from "../local/types";
import { Dialog } from "./Dialog";
import { dateTime, money } from "./format";

export function ShiftDialog({ shift, report, onReport, onPrintInterim, onClose, onCloseShift }: {
  shift: LocalShift; report: ShiftReport; onReport: (counted?: number) => ShiftReport | null; onPrintInterim: () => void; onClose: () => void; onCloseShift: (countedCash: number) => Promise<void>;
}) {
  const [counted, setCounted] = useState("");
  const [error, setError] = useState("");
  const live = counted === "" ? report : onReport(Number(counted)) ?? report;

  async function close(event: FormEvent) {
    event.preventDefault();
    if (counted === "") return setError("Count the cash in the drawer and enter it");
    try {
      await onCloseShift(Number(counted));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not close the shift");
    }
  }

  return <Dialog title="Shift and end of day" onClose={onClose} wide>
    <form className="stack" onSubmit={close}>
      <p className="muted">Opened {dateTime(shift.openedAt)} by {shift.userName} with {money(shift.openingCash)}</p>
      <div className="report-grid">
        <div><span>Sales</span><strong>{live.salesCount}</strong></div>
        <div><span>Net sales</span><strong>{money(live.netSales)}</strong></div>
        <div><span>Cash</span><strong>{money(live.byMethod.cash)}</strong></div>
        <div><span>Card</span><strong>{money(live.byMethod.card)}</strong></div>
        <div><span>Credit (udhaar)</span><strong>{money(live.byMethod.credit)}</strong></div>
        <div><span>Discounts</span><strong>{money(live.discounts)}</strong></div>
        <div><span>Voids / returns</span><strong>{live.voidCount} / {live.returnCount}</strong></div>
        <div><span>Cash refunds</span><strong>{money(live.refunds.cash)}</strong></div>
        <div className="emphasis"><span>Expected in drawer</span><strong>{money(live.expectedCash)}</strong></div>
      </div>
      <label>Counted cash in drawer<input autoFocus inputMode="decimal" value={counted} onChange={(event) => { setCounted(event.target.value.replace(/[^\d.]/g, "")); setError(""); }} placeholder="Count and enter" /></label>
      {live.variance != null && <p className={live.variance === 0 ? "ok-text" : "warning-text"}>{live.variance === 0 ? "Drawer balances." : live.variance < 0 ? `Short by ${money(-live.variance)}` : `Over by ${money(live.variance)}`}</p>}
      {error && <p className="warning-text">{error}</p>}
      <div className="row">
        <button type="button" onClick={onPrintInterim}>Print interim report</button>
        <button className="primary">Close shift and print <b>Enter</b></button>
      </div>
    </form>
  </Dialog>;
}
