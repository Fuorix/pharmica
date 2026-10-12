import { FormEvent, Fragment, useState } from "react";
import type { CreateTenantResponse, PlanSummary, TenantListItem } from "@pharmica/contracts";
import { TenantDetailPage } from "./TenantDetailPage";
import { ago, day, Message, money, send, StatusChip, useApi } from "./ui";

const emptyForm = { pharmacyName: "", contactName: "", phone: "", city: "", branchName: "Main", branchAddress: "", ownerName: "", ownerLogin: "", planCode: "starter", period: "MONTHLY", trialDays: "", counters: "1" };

/** Every pharmacy, onboarding a new one, and each one in detail. */
export function TenantsPage() {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateTenantResponse | null>(null);
  const { data, error, reload } = useApi<{ tenants: TenantListItem[] }>(`/api/v1/admin/tenants${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`);

  if (openId) return <TenantDetailPage id={openId} onBack={() => { setOpenId(null); void reload(); }} />;

  return <>
    <header className="page-head"><div><p className="eyebrow">TENANTS</p><h2>Pharmacies</h2></div><button onClick={() => { setCreating(!creating); setCreated(null); }}>{creating ? "Close" : "New pharmacy"}</button></header>
    {creating && !created && <CreateTenant onCreated={(response) => { setCreated(response); void reload(); }} />}
    {created && <Created response={created} onOpen={() => { setOpenId(created.tenant.id); setCreating(false); setCreated(null); }} />}
    <input className="search" placeholder="Search by name, city, phone, or owner login" value={query} onChange={(event) => setQuery(event.target.value)} />
    {error && <p className="message">{error}</p>}
    <table className="grid"><thead><tr><th>Pharmacy</th><th>Subscription</th><th>Counters</th><th>Last seen</th><th>Onboarding</th><th>Owes</th></tr></thead><tbody>
      {data?.tenants.map((tenant) => <tr key={tenant.id} className="clickable" onClick={() => setOpenId(tenant.id)}>
        <td><strong>{tenant.name}</strong><small>{[tenant.city, tenant.phone].filter(Boolean).join(" · ")}{tenant.isActive ? "" : " · SUSPENDED"}</small></td>
        <td><StatusChip status={tenant.status} /><small>{tenant.planName ?? ""}{tenant.paidThrough ? ` · to ${day(tenant.paidThrough)}` : ""}</small></td>
        <td>{tenant.activeDevices} / {tenant.devices}<small>{tenant.branches} branch{tenant.branches === 1 ? "" : "es"}</small></td>
        <td>{ago(tenant.lastSeenAt)}</td>
        <td><progress max={tenant.onboardingTotal} value={tenant.onboardingDone} /> <small>{tenant.onboardingDone}/{tenant.onboardingTotal}</small></td>
        <td className={tenant.openBalance ? "warn" : ""}>{tenant.openBalance ? money(tenant.openBalance) : "—"}</td>
      </tr>)}
    </tbody></table>
    {data && !data.tenants.length && <p className="muted">No pharmacies match.</p>}
  </>;
}

function CreateTenant({ onCreated }: { onCreated: (response: CreateTenantResponse) => void }) {
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState("");
  const { data: plans } = useApi<{ plans: PlanSummary[] }>("/api/v1/admin/plans");
  const field = (key: keyof typeof emptyForm) => ({ value: form[key], onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }) });
  const plan = plans?.plans.find((candidate) => candidate.code === form.planCode);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const response = await send<CreateTenantResponse>("/api/v1/admin/tenants", "POST", {
        ...form, phone: form.phone || undefined, city: form.city || undefined, branchAddress: form.branchAddress || undefined,
        trialDays: form.trialDays === "" ? undefined : Number(form.trialDays), counters: Number(form.counters)
      });
      setForm(emptyForm);
      onCreated(response);
    } catch (failure) {
      setMessage((failure as Error).message);
    }
  }

  return <form className="card form-grid" onSubmit={submit}>
    <h3>Onboard a pharmacy</h3>
    <label>Pharmacy name<input required {...field("pharmacyName")} /></label>
    <label>Contact person<input required {...field("contactName")} /></label>
    <label>Phone<input {...field("phone")} /></label>
    <label>City<input {...field("city")} /></label>
    <label>First branch<input required {...field("branchName")} /></label>
    <label>Branch address<input {...field("branchAddress")} /></label>
    <label>Owner name<input required {...field("ownerName")} /></label>
    <label>Owner login (email or phone)<input required {...field("ownerLogin")} /></label>
    <label>Plan<select {...field("planCode")}>{plans?.plans.filter((candidate) => candidate.isActive).map((candidate) => <option key={candidate.code} value={candidate.code}>{candidate.name} · {money(candidate.monthlyPrice)}/month</option>)}</select></label>
    <label>Billing<select {...field("period")}><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="YEARLY">Yearly</option></select></label>
    <label>Trial days<input type="number" min={0} max={90} placeholder={plan ? `${plan.trialDays} (plan default)` : ""} {...field("trialDays")} /></label>
    <label>Counters<input type="number" min={0} max={plan?.maxDevices ?? 20} required {...field("counters")} /></label>
    <div className="form-actions"><button>Create pharmacy</button><Message text={message} /></div>
  </form>;
}

function Created({ response, onOpen }: { response: CreateTenantResponse; onOpen: () => void }) {
  const owner = response.tenant.users.find((user) => user.role === "owner");
  return <div className="card created">
    <h3>✓ {response.tenant.name} is ready</h3>
    <p>Give the owner these details. The password is shown only now; they choose their own at first sign-in.</p>
    <dl>
      <dt>Owner login</dt><dd><code>{owner?.login}</code></dd>
      <dt>Temporary password</dt><dd><code className="secret">{response.temporaryPassword}</code></dd>
      {response.tenant.devices.map((device) => <Fragment key={device.id}><dt>{device.name} activation code</dt><dd><code>{device.activationCode}</code></dd></Fragment>)}
    </dl>
    <button onClick={onOpen}>Open pharmacy</button>
  </div>;
}
