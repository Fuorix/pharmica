import type { ShiftReport } from "@pharmica/domain";
import type { LocalPayment, LocalReturn, LocalSale, LocalShift } from "../local/types";
import { dateTime, plainMoney, unitLabel } from "./format";

export type PrintJob =
  | { kind: "receipt"; sale: LocalSale }
  | { kind: "return"; sale: LocalSale; saleReturn: LocalReturn }
  | { kind: "shift"; shift: LocalShift; report: ShiftReport }
  | { kind: "payment"; payment: LocalPayment };

type Header = { organisationName: string; branchName: string; deviceName: string; receiptHeader?: string; receiptFooter?: string; address?: string | null; phone?: string | null };

const DEFAULT_FOOTER = "Medicines are returned only with this receipt.";

/** Sends a job to the thermal printer through the system print dialog, sized for 58mm or 80mm paper. */
export function printNow(paperWidth: 58 | 80) {
  let style = document.getElementById("page-size");
  if (!style) {
    style = document.createElement("style");
    style.id = "page-size";
    document.head.appendChild(style);
  }
  style.textContent = `@page { size: ${paperWidth}mm auto; margin: 2mm; } .print-root { width: ${paperWidth - 6}mm; }`;
  window.setTimeout(() => window.print(), 50);
}

const methodName = { cash: "Cash", card: "Card", credit: "Credit (udhaar)" } as const;

function Top({ header, title }: { header: Header; title: string }) {
  return <div className="print-top">
    <strong>{header.organisationName}</strong>
    <span>{header.branchName}</span>
    {header.address && <span>{header.address}</span>}
    {header.phone && <span>Tel {header.phone}</span>}
    {header.receiptHeader && <span>{header.receiptHeader}</span>}
    <span>{title}</span>
  </div>;
}

export function Printable({ job, header }: { job: PrintJob | null; header: Header }) {
  if (!job) return null;
  if (job.kind === "shift") {
    const { shift, report } = job;
    return <div className="print-root">
      <Top header={header} title="END OF DAY · SHIFT CLOSING" />
      <p>{header.deviceName} · {shift.userName}<br />Opened {dateTime(shift.openedAt)}{shift.closedAt ? <><br />Closed {dateTime(shift.closedAt)}</> : null}</p>
      <table><tbody>
        <tr><td>Sales</td><td>{report.salesCount}</td></tr>
        <tr><td>Voided</td><td>{report.voidCount}</td></tr>
        <tr><td>Returns</td><td>{report.returnCount}</td></tr>
        <tr><td>Net sales</td><td>{plainMoney(report.netSales)}</td></tr>
        <tr><td>Discounts given</td><td>{plainMoney(report.discounts)}</td></tr>
        <tr className="rule"><td>Cash sales</td><td>{plainMoney(report.byMethod.cash)}</td></tr>
        <tr><td>Card sales</td><td>{plainMoney(report.byMethod.card)}</td></tr>
        <tr><td>Credit sales</td><td>{plainMoney(report.byMethod.credit)}</td></tr>
        <tr><td>Credit repaid (cash)</td><td>{plainMoney(report.collections.cash)}</td></tr>
        <tr><td>Credit repaid (card)</td><td>{plainMoney(report.collections.card)}</td></tr>
        <tr><td>Cash refunds</td><td>{plainMoney(report.refunds.cash)}</td></tr>
        <tr className="rule"><td>Opening cash</td><td>{plainMoney(report.openingCash)}</td></tr>
        <tr><td><b>Expected cash</b></td><td><b>{plainMoney(report.expectedCash)}</b></td></tr>
        {report.countedCash != null && <tr><td>Counted cash</td><td>{plainMoney(report.countedCash)}</td></tr>}
        {report.variance != null && <tr><td><b>{report.variance < 0 ? "Short" : report.variance > 0 ? "Over" : "Balanced"}</b></td><td><b>{plainMoney(Math.abs(report.variance))}</b></td></tr>}
      </tbody></table>
    </div>;
  }

  if (job.kind === "payment") {
    const { payment } = job;
    return <div className="print-root">
      <Top header={header} title="PAYMENT RECEIVED" />
      <p>{dateTime(payment.at)}<br />Customer: {payment.customerName}<br />Received by: {payment.userName}</p>
      <table><tbody>
        <tr className="rule"><td><b>Paid ({payment.method === "cash" ? "cash" : "card"})</b></td><td><b>{plainMoney(payment.amount)}</b></td></tr>
        <tr><td>Still owed</td><td>{plainMoney(payment.balanceAfter)}</td></tr>
      </tbody></table>
      <p className="print-foot">Thank you · {header.deviceName}</p>
    </div>;
  }

  const { sale } = job;
  const isReturn = job.kind === "return";
  const lines = isReturn
    ? job.saleReturn.lines.map((item) => ({ ...sale.lines.find((line) => line.lineId === item.saleLineId)!, quantity: item.quantity, lineTotal: item.amount, discount: 0 }))
    : sale.lines;
  return <div className="print-root">
    <Top header={header} title={isReturn ? "RETURN RECEIPT" : sale.status === "voided" ? "VOIDED SALE" : "SALE RECEIPT"} />
    <p>Receipt {sale.receiptNo}<br />{dateTime(isReturn ? job.saleReturn.at : sale.createdAt)}<br />Cashier: {isReturn ? job.saleReturn.userName : sale.userName}{sale.customerName ? <><br />Customer: {sale.customerName}</> : null}{sale.prescription ? <><br />Rx: {sale.prescription.patientName} · {sale.prescription.doctorName}{sale.prescription.prescriptionRef ? ` · ${sale.prescription.prescriptionRef}` : ""}</> : null}</p>
    <table className="items"><tbody>
      {lines.map((line) => <tr key={line.lineId}>
        <td>{line.name}<small>{unitLabel(line.unit, line.quantity, line.pieces)} × {plainMoney(line.unitPrice)}{line.discount ? ` − ${plainMoney(line.discount)}` : ""} · B:{line.batchNo}</small></td>
        <td>{plainMoney(line.lineTotal)}</td>
      </tr>)}
    </tbody></table>
    <table><tbody>
      {isReturn ? <>
        <tr className="rule"><td><b>Refund ({methodName[job.saleReturn.method]})</b></td><td><b>{plainMoney(job.saleReturn.amount)}</b></td></tr>
        <tr><td colSpan={2}>Reason: {job.saleReturn.reason}</td></tr>
      </> : <>
        <tr className="rule"><td>Subtotal</td><td>{plainMoney(sale.subtotal)}</td></tr>
        {sale.discount > 0 && <tr><td>Discount</td><td>−{plainMoney(sale.discount)}</td></tr>}
        <tr><td><b>Total</b></td><td><b>{plainMoney(sale.total)}</b></td></tr>
        <tr><td>{methodName[sale.paymentMethod]}</td><td>{plainMoney(sale.cashReceived ?? sale.total)}</td></tr>
        {sale.change ? <tr><td>Change</td><td>{plainMoney(sale.change)}</td></tr> : null}
      </>}
    </tbody></table>
    <p className="print-foot">{header.receiptFooter || DEFAULT_FOOTER}<br />Thank you · {header.deviceName}</p>
  </div>;
}
