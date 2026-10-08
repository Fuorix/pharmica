import { FormEvent, useState } from "react";
import type { ExpenseItem } from "@pharmica/contracts";
import { money } from "./accountsUi";
import { dayLabel, downloadCsv, PeriodPicker, pkToday, useReport, type Period } from "./reportsUi";
import { apiFetch, errorMessage, jsonBody } from "./session";

const CATEGORIES = ["Rent", "Electricity", "Gas", "Water", "Salaries", "Internet & phone", "Repairs", "Transport", "Tea & refreshments", "Other"];

/** Shop running costs. They come off gross profit in the profit-and-loss report; cash ones also come out of the cash book. */
export function ExpensesPage({ scope, branchId, branches }: { scope: string; branchId: string; branches: Array<{ id: string; name: string }> }) {
  const [period, setPeriod] = useState<Period>({ from: `${pkToday().slice(0, 8)}01`, to: pkToday() });
  const { data, reload } = useReport<{ expenses: ExpenseItem[] }>(`/api/v1/expenses?branchId=${scope}&from=${period.from}&to=${period.to}`);
  const [form, setForm] = useState({ category: "Electricity", amount: "", paidFrom: "cash", note: "", day: pkToday() });
  const [message, setMessage] = useState("");
  const expenses = data?.expenses ?? [];
  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const branchName = (id: string) => branches.find((branch) => branch.id === id)?.name ?? "";

  async function add(event: FormEvent) {
    event.preventDefault();
    const response = await apiFetch("/api/v1/expenses", { method: "POST", ...jsonBody({ branchId, category: form.category, amount: Number(form.amount), paidFrom: form.paidFrom, note: form.note || undefined, day: form.day }) });
    setMessage(response.ok ? `${form.category} ${money(Number(form.amount))} recorded` : await errorMessage(response, "Could not save the expense"));
    if (response.ok) { setForm({ ...form, amount: "", note: "" }); await reload(); }
  }

  async function remove(expense: ExpenseItem) {
    if (!window.confirm(`Delete ${expense.category} of ${money(expense.amount)}? The audit log keeps a record.`)) return;
    const response = await apiFetch("/api/v1/expenses", { method: "DELETE", ...jsonBody({ id: expense.id }) });
    setMessage(response.ok ? "Expense deleted" : await errorMessage(response, "Could not delete"));
    if (response.ok) await reload();
  }

  return <>
    <div className="page-heading"><h1>Expenses</h1><span className="page-note">{message}</span></div>
    <article className="panel">
      <div className="panel-heading"><h2>Record an expense</h2>{branches.length > 1 && <span>For {branchName(branchId)}</span>}</div>
      <form className="inventory-form" onSubmit={add}>
        <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select>
        <input required inputMode="decimal" placeholder="Amount (PKR)" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value.replace(/[^\d.]/g, "") })} />
        <select value={form.paidFrom} onChange={(event) => setForm({ ...form, paidFrom: event.target.value })}><option value="cash">Paid in cash</option><option value="bank">Paid from bank</option></select>
        <input type="date" required value={form.day} max={pkToday()} onChange={(event) => setForm({ ...form, day: event.target.value })} />
        <input placeholder="Note (optional)" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
        <button>Save</button>
      </form>
    </article>

    <PeriodPicker period={period} onChange={setPeriod} />
    <article className="panel catalogue-table">
      <div className="panel-heading"><h2>{money(total)} in {expenses.length} expense{expenses.length === 1 ? "" : "s"}</h2>
        <button className="secondary" onClick={() => downloadCsv(`expenses-${period.from}-${period.to}`, ["Date", "Branch", "Category", "Amount", "Paid from", "Note", "Recorded by"], expenses.map((expense) => [expense.spentAt.slice(0, 10), branchName(expense.branchId), expense.category, expense.amount, expense.paidFrom, expense.note ?? "", expense.recordedBy]))}>Download CSV</button></div>
      {expenses.length ? <table className="detail-table report-table"><thead><tr><th>Date</th>{branches.length > 1 && <th>Branch</th>}<th>Category</th><th>Amount</th><th>Paid from</th><th>Note</th><th>By</th><th /></tr></thead><tbody>
        {expenses.map((expense) => <tr key={expense.id}>
          <td>{dayLabel(new Date(new Date(expense.spentAt).getTime() + 5 * 3_600_000).toISOString().slice(0, 10))}</td>
          {branches.length > 1 && <td>{branchName(expense.branchId)}</td>}
          <td>{expense.category}</td><td>{money(expense.amount)}</td><td>{expense.paidFrom === "cash" ? "Cash" : "Bank"}</td><td>{expense.note}</td><td>{expense.recordedBy}</td>
          <td><button className="secondary" onClick={() => void remove(expense)}>Delete</button></td>
        </tr>)}
      </tbody></table> : <p className="empty-state">No expenses in this period.</p>}
    </article>
  </>;
}
