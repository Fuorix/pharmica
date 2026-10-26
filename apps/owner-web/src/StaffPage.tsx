import { FormEvent, useCallback, useEffect, useState } from "react";
import type { DeviceDiagnostics } from "@pharmica/contracts";
import { SyncIssuesPanel } from "./SyncIssuesPanel";
import { apiFetch, errorMessage, jsonBody, useOwnerSession } from "./session";

type Branch = { id: string; name: string };
type StaffUser = { id: string; name: string; login: string; role: "owner" | "cashier"; branchId: string | null; isActive: boolean; hasPin: boolean; maxDiscountPercent: number | null };
type Device = { id: string; name: string; counterNumber: number; branchId: string; activatedAt: string | null; isActive: boolean; lastSeenAt: string | null; diagnostics: DeviceDiagnostics | null; diagnosticsAt: string | null };

/** One line on how a counter's uploads are doing, from what it last reported. */
function deviceHealth(device: Device): string {
  const report = device.diagnostics;
  if (!report) return "no sync report yet";
  const parts = [report.pending ? `${report.pending} waiting to upload` : "all uploaded"];
  if (report.failed) parts.push(`${report.failed} rejected`);
  if (report.consecutiveFailures) parts.push(`${report.consecutiveFailures} failed syncs in a row`);
  return parts.join(", ");
}

const emptyUser = { name: "", login: "", role: "cashier" as "cashier" | "owner", branchId: "", pin: "", credential: "", maxDiscountPercent: "5" };

export function StaffPage({ branches }: { branches: Branch[] }) {
  const { user: me } = useOwnerSession();
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [shopCode, setShopCode] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [newUser, setNewUser] = useState({ ...emptyUser, branchId: branches[0]?.id ?? "" });
  const [newDevice, setNewDevice] = useState({ counterNumber: "", branchId: branches[0]?.id ?? "" });
  const branchName = (id: string | null) => id ? branches.find((branch) => branch.id === id)?.name ?? "Unknown branch" : "All branches";
  const used = new Set(devices.map((device) => device.counterNumber));
  let nextNumber = 1;
  while (used.has(nextNumber)) nextNumber++;

  const load = useCallback(async () => {
    const [userResponse, deviceResponse] = await Promise.all([apiFetch("/api/v1/users"), apiFetch("/api/v1/devices")]);
    if (userResponse.ok) setUsers((await userResponse.json()).users);
    if (deviceResponse.ok) {
      const body = await deviceResponse.json() as { shopCode: string | null; devices: Device[] };
      setDevices(body.devices);
      setShopCode(body.shopCode ?? "");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function send(path: string, method: string, body: unknown, success: string) {
    const response = await apiFetch(path, { method, ...jsonBody(body) });
    if (response.ok) {
      setMessage({ text: success });
      await load();
      return true;
    }
    setMessage({ text: await errorMessage(response, "Request failed"), error: true });
    return false;
  }

  async function addUser(event: FormEvent) {
    event.preventDefault();
    const body = newUser.role === "cashier"
      ? { name: newUser.name, login: newUser.login, role: "cashier", branchId: newUser.branchId, pin: newUser.pin, maxDiscountPercent: Number(newUser.maxDiscountPercent || 0) }
      : { name: newUser.name, login: newUser.login, role: "owner", credential: newUser.credential, ...(newUser.pin ? { pin: newUser.pin } : {}) };
    if (await send("/api/v1/users", "POST", body, `${newUser.name} added`)) setNewUser({ ...emptyUser, branchId: newUser.branchId });
  }

  function resetPin(member: StaffUser) {
    const pin = window.prompt(`New 4-6 digit PIN for ${member.name}`);
    if (pin) void send("/api/v1/users", "PATCH", { userId: member.id, pin }, `PIN changed for ${member.name}; their open sessions were signed out`);
  }

  function setDiscountLimit(member: StaffUser) {
    const input = window.prompt(`Largest discount ${member.name} may give, as % of the bill (0-100)`, String(member.maxDiscountPercent ?? 0));
    if (input === null) return;
    const percent = Number(input);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) return setMessage({ text: "Enter a whole percent from 0 to 100", error: true });
    void send("/api/v1/users", "PATCH", { userId: member.id, maxDiscountPercent: percent }, `${member.name} can now give up to ${percent}% discount`);
  }

  async function addDevice(event: FormEvent) {
    event.preventDefault();
    const counterNumber = Number(newDevice.counterNumber || nextNumber);
    const name = `${shopCode}-${counterNumber}`;
    if (await send("/api/v1/devices", "POST", { branchId: newDevice.branchId, counterNumber }, `${name} added. On the counter computer, open the POS and enter ${name} with a staff PIN`)) setNewDevice({ ...newDevice, counterNumber: "" });
  }

  return <>
    <div className="page-heading"><h1>Staff & devices</h1><span className={message?.error ? "page-note page-error" : "page-note"}>{message?.text}</span></div>
    <section className="content-grid">
      <article className="panel">
        <div className="panel-heading"><h2>Staff</h2><span>{users.length} people</span></div>
        {users.map((member) => <div className={member.isActive ? "staff-row" : "staff-row inactive"} key={member.id}>
          <div><strong>{member.name}{member.id === me.id ? " (you)" : ""}</strong><span>{member.login} · {member.role} · {branchName(member.branchId)}{member.hasPin ? " · PIN set" : " · no PIN"}{member.role === "cashier" ? ` · discount up to ${member.maxDiscountPercent ?? 0}%` : ""}</span></div>
          <div className="row-actions">
            <button className="secondary" onClick={() => resetPin(member)}>{member.hasPin ? "Reset PIN" : "Set PIN"}</button>
            {member.role === "cashier" && <button className="secondary" onClick={() => setDiscountLimit(member)}>Discount limit</button>}
            {member.id !== me.id && <button className="secondary" onClick={() => void send("/api/v1/users", "PATCH", { userId: member.id, isActive: !member.isActive }, `${member.name} ${member.isActive ? "deactivated and signed out" : "reactivated"}`)}>{member.isActive ? "Deactivate" : "Reactivate"}</button>}
          </div>
        </div>)}
        <form className="inventory-form" onSubmit={addUser}>
          <select value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value as "cashier" | "owner" })}><option value="cashier">Cashier (PIN only)</option><option value="owner">Owner (web + PIN)</option></select>
          <input required placeholder="Full name" value={newUser.name} onChange={(event) => setNewUser({ ...newUser, name: event.target.value })} />
          <input required placeholder={newUser.role === "owner" ? "Email or login" : "Login (e.g. ali.counter)"} value={newUser.login} onChange={(event) => setNewUser({ ...newUser, login: event.target.value })} />
          {newUser.role === "cashier" && <select required value={newUser.branchId} onChange={(event) => setNewUser({ ...newUser, branchId: event.target.value })}>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>}
          {newUser.role === "owner" && <input required type="password" minLength={8} placeholder="Password (8+ characters)" value={newUser.credential} onChange={(event) => setNewUser({ ...newUser, credential: event.target.value })} />}
          {newUser.role === "cashier" && <input inputMode="numeric" placeholder="Discount limit % (e.g. 5)" value={newUser.maxDiscountPercent} onChange={(event) => setNewUser({ ...newUser, maxDiscountPercent: event.target.value.replace(/D/g, "").slice(0, 3) })} />}
          <input required={newUser.role === "cashier"} inputMode="numeric" pattern="\d{4,6}" placeholder={newUser.role === "cashier" ? "PIN (4-6 digits)" : "POS PIN (optional)"} value={newUser.pin} onChange={(event) => setNewUser({ ...newUser, pin: event.target.value.replace(/\D/g, "") })} />
          <button type="submit">Add staff member</button>
        </form>
      </article>
      <article className="panel">
        <div className="panel-heading"><h2>POS devices</h2><span>{devices.filter((device) => device.isActive).length} active</span></div>
        {shopCode && <div className="shop-code-box">
          <div><span>Your shop ID</span><strong>{shopCode}</strong></div>
          <p>To set up a counter computer, open the POS on it and enter the counter name (like <b>{shopCode}-1</b>) with any staff PIN. This is needed once per computer.</p>
        </div>}
        {devices.map((device) => <div className={device.isActive ? "staff-row" : "staff-row inactive"} key={device.id}>
          <div><strong>{device.name}</strong><span>{branchName(device.branchId)} · {!device.isActive ? "turned off" : device.activatedAt ? `linked, ${deviceHealth(device)}, last seen ${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "never"}` : "not set up yet: enter this name with a staff PIN on the counter computer"}</span></div>
          <div className="row-actions">
            {device.activatedAt && <button className="secondary" onClick={() => window.confirm(`Unlink ${device.name} from its computer? That computer stops selling, and the counter can then be set up on another computer.`) && void send("/api/v1/devices", "PATCH", { deviceId: device.id, unlink: true }, `${device.name} unlinked; set it up on the new computer with a staff PIN`)}>Unlink</button>}
            <button className="secondary" onClick={() => void send("/api/v1/devices", "PATCH", { deviceId: device.id, isActive: !device.isActive }, `${device.name} ${device.isActive ? "turned off; it can no longer sell" : "turned on"}`)}>{device.isActive ? "Turn off" : "Turn on"}</button>
          </div>
        </div>)}
        <form className="inventory-form counter-form" onSubmit={addDevice}>
          <label className="counter-name">Counter name<span><b>{shopCode || "……"}-</b><input inputMode="numeric" aria-label="Counter number" placeholder={String(nextNumber)} value={newDevice.counterNumber} onChange={(event) => setNewDevice({ ...newDevice, counterNumber: event.target.value.replace(/\D/g, "").slice(0, 4) })} /></span></label>
          <select required aria-label="Branch" value={newDevice.branchId} onChange={(event) => setNewDevice({ ...newDevice, branchId: event.target.value })}>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>
          <button type="submit" disabled={!shopCode}>Add counter</button>
        </form>
      </article>
    </section>
    <SyncIssuesPanel branches={branches} />
  </>;
}
