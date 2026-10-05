import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivateDeviceResponse, PosStaffMember } from "@pharmica/contracts";
import { openLocalDb, type LocalDb } from "./local/db";
import { PosEngine } from "./local/engine";
import { checkPin, createPinVerifier, type PinVerifier } from "./local/pin";
import { httpTransport } from "./local/transport";
import { apiFetch, apiUrl, loadDevice, PosSessionContext, saveDevice, useEngineState, type PosDevice } from "./session";

type Stage =
  | { name: "loading" }
  | { name: "activate"; notice?: string }
  | { name: "ready"; engine: PosEngine; db: LocalDb; device: PosDevice; user: PosStaffMember | null };

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>({ name: "loading" });

  const start = useCallback(async (notice?: string) => {
    const stored = loadDevice();
    if (!stored) return setStage({ name: "activate", notice });
    const db = await openLocalDb();
    const engine = await PosEngine.open(db, httpTransport(apiUrl, stored.deviceToken), stored.device.id);
    setStage({ name: "ready", engine, db, device: stored.device, user: null });
  }, []);

  useEffect(() => { void start(); }, [start]);

  // Background uploads run for as long as the counter is open, signed in or not.
  const engine = stage.name === "ready" ? stage.engine : null;
  useEffect(() => engine?.start(), [engine]);

  if (stage.name === "loading") return <main className="auth-state">Starting counter...</main>;
  if (stage.name === "activate") return <ActivateScreen notice={stage.notice} onActivated={() => void start()} />;
  if (!stage.user) {
    return <PinScreen engine={stage.engine} db={stage.db} device={stage.device} onSignedIn={(user) => setStage({ ...stage, user })} onReactivate={() => { saveDevice(null); void start("Enter the new activation code from the owner panel."); }} />;
  }
  const lock = () => {
    void apiFetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    setStage({ ...stage, user: null });
  };
  return <PosSessionContext.Provider value={{ user: stage.user, device: stage.device, engine: stage.engine, lock }}>{children}</PosSessionContext.Provider>;
}

function ActivateScreen({ notice, onActivated }: { notice?: string; onActivated: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/v1/devices/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ activationCode: code }) });
      if (!response.ok) return setError(await errorMessage(response, "Activation failed"));
      const activated = await response.json() as ActivateDeviceResponse;
      saveDevice({ deviceToken: activated.deviceToken, device: activated.device });
      onActivated();
    } catch {
      setError("Activation needs the internet once. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-page"><form className="auth-card" onSubmit={submit}>
    <p className="eyebrow">PHARMICA POS · SETUP</p>
    <h1>Activate this counter</h1>
    <p className="auth-note">{notice ?? "Enter the activation code from the owner panel (Staff & devices). This is done once per computer and needs the internet."}</p>
    <label>Activation code<input autoFocus required value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="e.g. 3FA9C21B07DE" autoComplete="off" /></label>
    {error && <p className="auth-error">{error}</p>}
    <button className="auth-primary" disabled={busy || !code.trim()}>{busy ? "Activating..." : "Activate"}</button>
  </form></main>;
}

function PinScreen({ engine, db, device, onSignedIn, onReactivate }: { engine: PosEngine; db: LocalDb; device: PosDevice; onSignedIn: (user: PosStaffMember) => void; onReactivate: () => void }) {
  const state = useEngineState(engine);
  const staff = useMemo(() => state.snapshot?.staff ?? [], [state.snapshot]);
  const [selected, setSelected] = useState<PosStaffMember | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (selected) pinRef.current?.focus(); }, [selected]);

  // Keyboard-first: number keys pick a staff member until a PIN is being typed; Esc goes back.
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") { setSelected(null); setPin(""); setError(""); return; }
      if (document.activeElement === pinRef.current) return;
      const member = staff[Number(event.key) - 1];
      if (member) { event.preventDefault(); setSelected(member); setError(""); }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [staff]);

  /** Online: the server checks the PIN (with its lockout and audit), and the counter remembers it for offline use. */
  async function signInOnline(member: PosStaffMember): Promise<"ok" | "offline" | string> {
    let response: Response;
    try {
      response = await apiFetch("/api/v1/auth/pin-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: member.id, pin }) });
    } catch {
      return "offline";
    }
    if (response.status >= 500) return "offline";
    if (!response.ok) return errorMessage(response, "Sign-in failed");
    await db.write([{ collection: "pins", id: member.id, value: await createPinVerifier(member.id, pin) }]);
    return "ok";
  }

  async function signInOffline(member: PosStaffMember): Promise<"ok" | string> {
    const verifier = await db.get<PinVerifier>("pins", member.id);
    if (!verifier) return `${member.name} has not signed in on this counter while online yet, so can't sign in offline`;
    const result = await checkPin(verifier, pin);
    await db.write([{ collection: "pins", id: member.id, value: result.verifier }]);
    if (result.ok) return "ok";
    return result.locked ? "Too many wrong PINs. Try again in 15 minutes" : "Invalid PIN";
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      let outcome = await signInOnline(selected);
      if (outcome === "offline") outcome = await signInOffline(selected);
      setPin("");
      if (outcome === "ok") onSignedIn(selected);
      else setError(outcome);
    } finally {
      setBusy(false);
    }
  }

  if (state.deviceRevoked) {
    return <main className="auth-page"><div className="auth-card">
      <p className="eyebrow">PHARMICA POS</p><h1>Counter deactivated</h1>
      <p className="auth-note">The owner deactivated or reset this counter, so it can no longer sell.{state.sync.pending + state.sync.failed ? ` ${state.sync.pending + state.sync.failed} change(s) on this counter have not reached the server yet and will upload once it is activated again.` : ""}</p>
      <button className="auth-primary" onClick={onReactivate}>Enter a new activation code</button>
    </div></main>;
  }

  if (!state.snapshot) {
    return <main className="auth-page"><div className="auth-card">
      <p className="eyebrow">PHARMICA POS · {device.name.toUpperCase()}</p><h1>Downloading the catalogue</h1>
      <p className="auth-note">{state.sync.syncing ? "Fetching medicines, stock, and staff..." : "This counter needs the internet once to download its catalogue. After that it works offline."}</p>
      {state.sync.error && <p className="auth-error">{state.sync.error}</p>}
      <button className="auth-primary" disabled={state.sync.syncing} onClick={() => void engine.syncNow()}>{state.sync.syncing ? "Working..." : "Try again"}</button>
    </div></main>;
  }

  return <main className="auth-page"><div className="auth-card auth-wide">
    <p className="eyebrow">PHARMICA POS · {device.branchName.toUpperCase()} · {device.name.toUpperCase()}{state.sync.online ? "" : " · OFFLINE"}</p>
    <h1>Who is at the counter?</h1>
    {staff.length === 0 && <p className="auth-note">No staff have a PIN for this branch yet. The owner can add one under Staff & devices.</p>}
    <div className="staff-grid">{staff.map((member, index) => <button key={member.id} type="button" className={member.id === selected?.id ? "staff selected" : "staff"} onClick={() => { setSelected(member); setError(""); }}>
      <b>{index + 1}</b><strong>{member.name}</strong><span>{member.role}</span>
    </button>)}</div>
    {selected && <form className="pin-form" onSubmit={submit}>
      <label>PIN for {selected.name}<input ref={pinRef} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} /></label>
      <button className="auth-primary" disabled={pin.length < 4 || busy}>{busy ? "Checking..." : "Sign in"}</button>
    </form>}
    {error && <p className="auth-error">{error}</p>}
  </div></main>;
}
