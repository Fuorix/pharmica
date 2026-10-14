import { useCallback, useEffect, useState } from "react";
import type { ControlledRegisterEntry } from "@pharmica/contracts";
import { apiFetch } from "./session";

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

/** The narcotics register: every controlled-drug sale with patient and doctor, and reversals. Read-only. */
export function RegisterPage({ branchId }: { branchId: string }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [entries, setEntries] = useState<ControlledRegisterEntry[]>([]);

  const load = useCallback(async () => {
    const response = await apiFetch(`/api/v1/controlled-drugs?branchId=${branchId}&from=${from}&to=${to}`);
    if (response.ok) setEntries((await response.json()).entries);
  }, [branchId, from, to]);
  useEffect(() => { void load(); }, [load]);

  return <>
    <div className="page-heading no-print"><h1>Narcotics register</h1><button onClick={() => window.print()}>Print</button></div>
    <p className="page-note no-print">Entries are made only by sales at the counter, with the prescription the cashier entered. They can never be edited or deleted; voids and returns appear as reversal entries.</p>
    <div className="filter-bar no-print">
      <label>From <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>To <input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
    </div>
    <article className="panel">
      <h2 className="print-only">Narcotics register · {from} to {to}</h2>
      <table className="detail-table register"><thead><tr><th>Date</th><th>Medicine</th><th>Batch</th><th>Qty</th><th>Patient</th><th>Doctor</th><th>Rx</th><th>Receipt</th><th>By</th></tr></thead><tbody>
        {entries.map((entry) => <tr key={entry.id} className={entry.entryType === "REVERSAL" ? "reversal" : ""}>
          <td>{new Date(entry.at).toLocaleString("en-PK", { dateStyle: "short", timeStyle: "short" })}</td>
          <td>{entry.productName}{entry.entryType === "REVERSAL" ? <small>reversal</small> : null}</td>
          <td>{entry.batchNo ?? "—"}</td>
          <td>{entry.quantity} {entry.unit}{Math.abs(entry.quantity) === 1 ? "" : "s"}</td>
          <td>{entry.patientName}{entry.patientPhone ? <small>{entry.patientPhone}</small> : null}</td>
          <td>{entry.doctorName}{entry.doctorRegNo ? <small>{entry.doctorRegNo}</small> : null}</td>
          <td>{entry.prescriptionRef ?? "—"}</td>
          <td>{entry.receiptNo ?? "—"}</td>
          <td>{entry.recordedBy}</td>
        </tr>)}
      </tbody></table>
      {!entries.length && <p className="page-note">No controlled-drug sales in this period.</p>}
    </article>
  </>;
}
