import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import type { AuthResponse, AuthUser } from "@pharmica/contracts";
import { apiFetch, errorMessage, jsonBody, AdminSessionContext } from "./session";

const WRONG_PANEL = "This panel is for the Pharmica team only. Pharmacy owners use the owner panel.";

export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [login, setLogin] = useState("admin@pharmica.local");
  const [credential, setCredential] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  const accept = useCallback(async (candidate: AuthUser) => {
    if (candidate.role === "super-admin") return setUser(candidate);
    await apiFetch("/api/v1/auth/logout", { method: "POST" });
    setError(WRONG_PANEL);
    setUser(null);
  }, []);

  useEffect(() => {
    apiFetch("/api/v1/auth/me")
      .then(async (response) => response.ok ? accept((await response.json() as AuthResponse).user) : setUser(null))
      .catch(() => setUser(null));
  }, [accept]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const response = await apiFetch("/api/v1/auth/login", { method: "POST", ...jsonBody({ login, credential }) });
      if (!response.ok) return setError(await errorMessage(response, "Invalid login or password"));
      setCredential("");
      await accept((await response.json() as AuthResponse).user);
    } catch {
      setError("Can't reach Pharmica. Check the internet connection.");
    }
  }

  const signOut = useCallback(() => {
    void apiFetch("/api/v1/auth/logout", { method: "POST" }).finally(() => setUser(null));
  }, []);

  if (user === undefined) return <main className="auth-state">Checking session...</main>;
  if (user) return <AdminSessionContext.Provider value={{ user, signOut }}>{children}</AdminSessionContext.Provider>;

  return <main className="auth-page"><form className="auth-card" onSubmit={submit}>
    <p className="eyebrow">PHARMICA OPS</p><h1>Sign in</h1>
    <label>Login<input autoComplete="username" value={login} onChange={(event) => setLogin(event.target.value)} /></label>
    <label>Password
      <span className="password-field">
        <input type={showPassword ? "text" : "password"} autoComplete="current-password" value={credential} onChange={(event) => setCredential(event.target.value)} />
        <button type="button" className="password-reveal" aria-label="Hold to show password" onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setShowPassword(true); }} onPointerUp={() => setShowPassword(false)} onPointerCancel={() => setShowPassword(false)}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-9.3 3.1-11 7.5C2.7 16.9 7 20 12 20s9.3-3.1 11-7.5C21.3 8.1 17 5 12 5Zm0 12.5A5 5 0 1 1 12 7a5 5 0 0 1 0 10.5Zm0-2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/></svg>
        </button>
      </span>
    </label>
    {error && <p className="auth-error">{error}</p>}
    <button type="submit">Sign in</button>
  </form></main>;
}
