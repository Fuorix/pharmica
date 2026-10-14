import { useState } from "react";
import type { PlanSummary } from "@pharmica/contracts";
import { Message, money, send, useApi } from "./ui";

const FEATURES: Array<[string, string]> = [["reports", "Reports"], ["accounting", "Accounting"], ["mobile", "Mobile app"]];
type Plan = PlanSummary & { subscriptions: number };
const blank = { code: "", name: "", monthlyPrice: "", quarterlyDiscountPercent: "5", yearlyDiscountPercent: "15", maxBranches: "", maxDevices: "", trialDays: "14", features: ["reports"] as string[] };

/** Plans and prices. A change applies to invoices issued from now; open invoices keep their price. */
export function PlansPage() {
  const { data, reload } = useApi<{ plans: Plan[] }>("/api/v1/admin/plans");
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState(blank);
  const limit = (value: string) => value.trim() === "" ? null : Number(value);

  async function update(plan: Plan, change: Partial<PlanSummary>, done: string) {
    try { await send("/api/v1/admin/plans", "PATCH", { id: plan.id, ...change }); setMessage(`✓ ${done}`); await reload(); } catch (failure) { setMessage((failure as Error).message); }
  }
  const edit = (plan: Plan, field: "monthlyPrice" | "maxBranches" | "maxDevices" | "trialDays" | "quarterlyDiscountPercent" | "yearlyDiscountPercent", label: string) => {
    const value = window.prompt(`${label} for ${plan.name}${field.startsWith("max") ? " (empty = no limit)" : ""}`, plan[field] == null ? "" : String(plan[field]));
    if (value === null) return;
    void update(plan, { [field]: field.startsWith("max") ? limit(value) : Number(value) }, `${plan.name}: ${label.toLowerCase()} updated`);
  };

  async function create() {
    try {
      await send("/api/v1/admin/plans", "POST", { code: draft.code, name: draft.name, monthlyPrice: Number(draft.monthlyPrice), quarterlyDiscountPercent: Number(draft.quarterlyDiscountPercent), yearlyDiscountPercent: Number(draft.yearlyDiscountPercent), maxBranches: limit(draft.maxBranches), maxDevices: limit(draft.maxDevices), trialDays: Number(draft.trialDays), features: draft.features, isActive: true });
      setDraft(blank); setMessage("✓ Plan created"); await reload();
    } catch (failure) { setMessage((failure as Error).message); }
  }

  return <>
    <header className="page-head"><div><p className="eyebrow">PLANS</p><h2>Plans and pricing</h2></div></header>
    <p className="muted">Price changes apply to invoices issued from now on. Prepay discounts apply to quarterly and yearly billing.</p>
    <Message text={message} />
    <table className="grid"><thead><tr><th>Plan</th><th>Per month</th><th>Prepay discount</th><th>Branches</th><th>Counters</th><th>Trial</th><th>Features</th><th>Shops</th><th /></tr></thead><tbody>
      {data?.plans.map((plan) => <tr key={plan.id} className={plan.isActive ? "" : "inactive"}>
        <td><strong>{plan.name}</strong><small>{plan.code}</small></td>
        <td><button className="link" onClick={() => edit(plan, "monthlyPrice", "Monthly price")}>{money(plan.monthlyPrice)}</button></td>
        <td><button className="link" onClick={() => edit(plan, "quarterlyDiscountPercent", "Quarterly discount %")}>{plan.quarterlyDiscountPercent}%</button> / <button className="link" onClick={() => edit(plan, "yearlyDiscountPercent", "Yearly discount %")}>{plan.yearlyDiscountPercent}%</button></td>
        <td><button className="link" onClick={() => edit(plan, "maxBranches", "Branches")}>{plan.maxBranches ?? "Any"}</button></td>
        <td><button className="link" onClick={() => edit(plan, "maxDevices", "Counters")}>{plan.maxDevices ?? "Any"}</button></td>
        <td><button className="link" onClick={() => edit(plan, "trialDays", "Trial days")}>{plan.trialDays} days</button></td>
        <td>{FEATURES.map(([key, label]) => <label key={key} className="check"><input type="checkbox" checked={plan.features.includes(key)} onChange={(event) => void update(plan, { features: event.target.checked ? [...plan.features, key] : plan.features.filter((feature) => feature !== key) }, `${plan.name}: ${label.toLowerCase()} ${event.target.checked ? "added" : "removed"}`)} /> {label}</label>)}</td>
        <td>{plan.subscriptions}</td>
        <td><button className="ghost" onClick={() => void update(plan, { isActive: !plan.isActive }, plan.isActive ? `${plan.name} hidden from new sign-ups` : `${plan.name} offered again`)}>{plan.isActive ? "Retire" : "Offer"}</button></td>
      </tr>)}
    </tbody></table>
    <section className="card form-grid">
      <h3>New plan</h3>
      <label>Code<input value={draft.code} placeholder="e.g. pro-plus" onChange={(event) => setDraft({ ...draft, code: event.target.value })} /></label>
      <label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>Per month (PKR)<input inputMode="decimal" value={draft.monthlyPrice} onChange={(event) => setDraft({ ...draft, monthlyPrice: event.target.value })} /></label>
      <label>Branches (empty = any)<input value={draft.maxBranches} onChange={(event) => setDraft({ ...draft, maxBranches: event.target.value })} /></label>
      <label>Counters (empty = any)<input value={draft.maxDevices} onChange={(event) => setDraft({ ...draft, maxDevices: event.target.value })} /></label>
      <label>Trial days<input value={draft.trialDays} onChange={(event) => setDraft({ ...draft, trialDays: event.target.value })} /></label>
      <div className="row">{FEATURES.map(([key, label]) => <label key={key} className="check"><input type="checkbox" checked={draft.features.includes(key)} onChange={(event) => setDraft({ ...draft, features: event.target.checked ? [...draft.features, key] : draft.features.filter((feature) => feature !== key) })} /> {label}</label>)}</div>
      <div className="form-actions"><button onClick={() => void create()} disabled={!draft.code || !draft.name || !draft.monthlyPrice}>Create plan</button></div>
    </section>
  </>;
}
