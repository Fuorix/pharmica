import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LinkDeviceResponse, PosStaffMember } from "@pharmica/contracts";
import { openLocalDb, type LocalDb } from "./local/db";
import { PosEngine } from "./local/engine";
import { checkPin, createPinVerifier, type PinVerifier } from "./local/pin";
import { httpTransport } from "./local/transport";
import { apiFetch, apiUrl, loadDevice, loadSignedInUserId, PosSessionContext, saveDevice, saveSignedInUserId, useEngineState, type PosDevice } from "./session";

/** Who linked the counter, so they are signed in once the catalogue is down instead of typing their PIN twice. */
type AutoSignIn = { userId: string; pin: string };

type Stage =
  | { name: "loading" }
  | { name: "link"; notice?: string }
  | { name: "ready"; engine: PosEngine; db: LocalDb; device: PosDevice; user: PosStaffMember | null; autoSignIn?: AutoSignIn };

const UNREACHABLE = "Cannot reach Pharmica. If the internet is working, the server may be starting up: wait a minute and try again.";

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>({ name: "loading" });

  const start = useCallback(async (options: { notice?: string; autoSignIn?: AutoSignIn } = {}) => {
    const stored = loadDevice();
    if (!stored) return setStage({ name: "link", notice: options.notice });
    const db = await openLocalDb();
    const engine = await PosEngine.open(db, httpTransport(apiUrl, stored.deviceToken), stored.device.id);
    const savedId = loadSignedInUserId();
    const user = savedId ? engine.getState().snapshot?.staff.find((member) => member.id === savedId) ?? null : null;
    if (savedId && !user) saveSignedInUserId(null);
    setStage({ name: "ready", engine, db, device: stored.device, user, autoSignIn: options.autoSignIn });
  }, []);

  useEffect(() => { void start(); }, [start]);

  // Background uploads run for as long as the counter is open, signed in or not.
  const engine = stage.name === "ready" ? stage.engine : null;
  useEffect(() => engine?.start(), [engine]);

  if (stage.name === "loading") return <main className="auth-state">Starting counter...</main>;
  if (stage.name === "link") return <LinkScreen notice={stage.notice} onLinked={(autoSignIn) => void start({ autoSignIn })} />;
  if (!stage.user) {
    const relink = () => {
      saveDevice(null);
      saveSignedInUserId(null);
      void start({ notice: "Enter the counter name and your PIN to link this computer again. If the counter is still linked to another computer, the owner can unlink it under Staff & devices." });
    };
    return <PinScreen engine={stage.engine} db={stage.db} device={stage.device} autoSignIn={stage.autoSignIn} onSignedIn={(user) => { saveSignedInUserId(user.id); setStage({ ...stage, user, autoSignIn: undefined }); }} onRelink={relink} />;
  }
  const lock = () => {
    saveSignedInUserId(null);
    void apiFetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    setStage({ ...stage, user: null });
  };
  return <PosSessionContext.Provider value={{ user: stage.user, device: stage.device, engine: stage.engine, lock }}>{children}</PosSessionContext.Provider>;
}

/** First run on a computer: the counter name from the owner panel (like K7P2QX-1) and the PIN of anyone who works there. */
function LinkScreen({ notice, onLinked }: { notice?: string; onLinked: (autoSignIn: AutoSignIn) => void }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      // A sleeping test server can take up to a minute to answer, so this waits longer than a normal request.
      const response = await apiFetch("/api/v1/devices/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceName: name, pin }), signal: AbortSignal.timeout(75_000) });
      if (!response.ok) return setError(await errorMessage(response, "This counter could not be set up"));
      const linked = await response.json() as LinkDeviceResponse;
      saveDevice({ deviceToken: linked.deviceToken, device: linked.device });
      onLinked({ userId: linked.userId, pin });
    } catch {
      setError(UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-page"><form className="auth-card" onSubmit={submit}>
    <p className="eyebrow">PHARMICA POS · SETUP</p>
    <h1>Set up this counter</h1>
    <p className="auth-note">{notice ?? "Enter the counter name from the owner panel (Staff & devices) and your PIN. This is done once per computer and needs the internet."}</p>
    <label>Counter name<input autoFocus required value={name} onChange={(event) => setName(event.target.value.toUpperCase())} placeholder="e.g. K7P2QX-1" autoComplete="off" spellCheck={false} /></label>
    <label>Your PIN<input required type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(event) => { setPin(event.target.value.replace(/\D/g, "")); setError(/\D/.test(event.target.value) ? "The PIN is numbers only." : ""); }} /></label>
    {error && <p className="auth-error">{error}</p>}
    <button className="auth-primary" disabled={busy || !name.trim() || pin.length < 4}>{busy ? "Setting up..." : "Set up counter"}</button>
  </form></main>;
}

function PinScreen({ engine, db, device, autoSignIn, onSignedIn, onRelink }: { engine: PosEngine; db: LocalDb; device: PosDevice; autoSignIn?: AutoSignIn; onSignedIn: (user: PosStaffMember) => void; onRelink: () => void }) {
  const state = useEngineState(engine);
  const staff = useMemo(() => state.snapshot?.staff ?? [], [state.snapshot]);
  const [selected, setSelected] = useState<PosStaffMember | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const autoTried = useRef(false);

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
  async function signInOnline(member: PosStaffMember, pin: string): Promise<"ok" | "offline" | string> {
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

  async function signInOffline(member: PosStaffMember, pin: string): Promise<"ok" | string> {
    const verifier = await db.get<PinVerifier>("pins", member.id);
    if (!verifier) return `${member.name} has not signed in on this counter while online yet, so can't sign in offline`;
    const result = await checkPin(verifier, pin);
    await db.write([{ collection: "pins", id: member.id, value: result.verifier }]);
    if (result.ok) return "ok";
    return result.locked ? "Too many wrong PINs. Try again in 15 minutes" : "Invalid PIN";
  }

  async function signIn(member: PosStaffMember, pin: string) {
    setBusy(true);
    setError("");
    try {
      let outcome = await signInOnline(member, pin);
      if (outcome === "offline") outcome = await signInOffline(member, pin);
      setPin("");
      if (outcome === "ok") onSignedIn(member);
      else setError(outcome);
    } finally {
      setBusy(false);
    }
  }

  // Right after linking, the person who linked the counter is signed in as soon as their name has downloaded.
  const autoMember = autoSignIn ? staff.find((member) => member.id === autoSignIn.userId) : undefined;
  useEffect(() => {
    if (!autoSignIn || !autoMember || autoTried.current) return;
    autoTried.current = true;
    setSelected(autoMember);
    void signIn(autoMember, autoSignIn.pin);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, when the linking person first appears
  }, [autoMember]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    void signIn(selected, pin);
  }

  if (state.deviceRevoked) {
    return <main className="auth-page"><div className="auth-card">
      <p className="eyebrow">PHARMICA POS</p><h1>Counter turned off</h1>
      <p className="auth-note">The owner turned off or unlinked this counter, so it can no longer sell.{state.sync.pending + state.sync.failed ? ` ${state.sync.pending + state.sync.failed} change(s) on this counter have not reached the server yet and will upload once it is linked again.` : ""}</p>
      <button className="auth-primary" onClick={onRelink}>Link this computer again</button>
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
      <label>PIN for {selected.name}<input ref={pinRef} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(event) => { setPin(event.target.value.replace(/\D/g, "")); setError(/\D/.test(event.target.value) ? "The PIN is numbers only." : ""); }} /></label>
      <button className="auth-primary" disabled={pin.length < 4 || busy}>{busy ? "Checking..." : "Sign in"}</button>
    </form>}
    {error && <p className="auth-error">{error}</p>}
  </div></main>;
}
