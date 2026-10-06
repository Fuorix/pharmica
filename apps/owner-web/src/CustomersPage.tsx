import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage, jsonBody } from "./session";

type Customer = { id: string; name: string; phone: string | null; balance: number; creditLimit: number };

/** Customer credit (khata): add customers and record what they pay back. */
export function CustomersPage({ branchId }: { branchId: string }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [message, setMessage] = useState("");
  const [customer, setCustomer] = useState({ name: "", phone: "", creditLimit: "" });
  const [payment, setPayment] = useState({ customerId: "", amount: "" });

  const load = useCallback(async () => {
    const response = await apiFetch(`/api/v1/customers?branchId=${branchId}`);
    if (response.ok) setCustomers((await response.json()).customers);
  }, [branchId]);

  useEffect(() => { void load(); }, [load]);

  async function createCustomer(event: FormEvent) {
    event.preventDefault();
    const response = await apiFetch("/api/v1/customers", { method: "POST", ...jsonBody({ branchId, name: customer.name, phone: customer.phone || undefined, creditLimit: Number(customer.creditLimit || 0) }) });
    setMessage(response.ok ? `${customer.name} added` : await errorMessage(response, "Could not add customer"));
    if (response.ok) { setCustomer({ name: "", phone: "", creditLimit: "" }); await load(); }
  }

  async function recordPayment(event: FormEvent) {
    event.preventDefault();
    const response = await apiFetch(`/api/v1/customers/${payment.customerId}/ledger`, { method: "POST", ...jsonBody({ type: "PAYMENT", amount: Number(payment.amount), note: "Customer payment" }) });
    setMessage(response.ok ? "Payment recorded" : await errorMessage(response, "Could not record payment"));
    if (response.ok) { setPayment({ customerId: "", amount: "" }); await load(); }
  }

  return <>
    <div className="page-heading"><h1>Customers</h1><span className="page-note">{message}</span></div>
    <article className="panel ledger-panel">
      <div className="panel-heading"><h2>Customer credit (khata)</h2><span>{customers.length} customers · PKR {customers.reduce((sum, item) => sum + item.balance, 0).toFixed(2)} owed</span></div>
      <div className="ledger-forms">
        <form onSubmit={createCustomer}><input required placeholder="Customer name" value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} /><input placeholder="Phone" value={customer.phone} onChange={(event) => setCustomer({ ...customer, phone: event.target.value })} /><input inputMode="decimal" placeholder="Credit limit (0 = none)" value={customer.creditLimit} onChange={(event) => setCustomer({ ...customer, creditLimit: event.target.value.replace(/[^\d.]/g, "") })} /><button>Add customer</button></form>
        <form onSubmit={recordPayment}><select required value={payment.customerId} onChange={(event) => setPayment({ ...payment, customerId: event.target.value })}><option value="">Customer payment</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name} · PKR {item.balance.toFixed(2)}</option>)}</select><input required inputMode="decimal" placeholder="Amount" value={payment.amount} onChange={(event) => setPayment({ ...payment, amount: event.target.value.replace(/[^\d.]/g, "") })} /><button>Record payment</button></form>
      </div>
      {customers.map((item) => <div className="ledger-row" key={item.id}><strong>{item.name}</strong><span>{item.phone ?? "No phone"}</span><b>PKR {item.balance.toFixed(2)} owed</b></div>)}
    </article>
  </>;
}
