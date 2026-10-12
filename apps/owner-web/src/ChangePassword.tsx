import { FormEvent, useState } from "react";
import { apiFetch, errorMessage, jsonBody } from "./session";

/** First sign-in with a temporary password from Pharmica: the owner picks their own before anything else. */
export function ChangePassword({ name, onDone, onSignOut }: { name: string; onDone: () => void; onSignOut: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next.length < 8) return setError("Use at least 8 characters");
    if (next !== repeat) return setError("The two new passwords are different");
    const response = await apiFetch("/api/v1/auth/password", { method: "POST", ...jsonBody({ currentCredential: current, newCredential: next }) });
    if (!response.ok) return setError(await errorMessage(response, "Could not change the password"));
    onDone();
  }

  return <main className="auth-page"><form className="auth-card" onSubmit={submit}>
    <p className="eyebrow">PHARMICA OWNER</p><h1>Welcome, {name}</h1>
    <p className="page-note">You signed in with the temporary password from Pharmica. Choose your own password to continue.</p>
    <label>Temporary password<input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} /></label>
    <label>New password<input type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} /></label>
    <label>New password again<input type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} /></label>
    {error && <p className="auth-error">{error}</p>}
    <button type="submit">Save password</button>
    <button type="button" className="secondary" onClick={onSignOut}>Sign out</button>
  </form></main>;
}
