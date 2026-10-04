import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import type { AuthResponse, AuthUser } from "@pharmica/contracts";
import { apiFetch, errorMessage, jsonBody, OwnerSessionContext } from "./session";

const WRONG_PANEL = "This panel is for pharmacy owners. Cashiers sign in at the POS counter.";

export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [login, setLogin] = useState("owner@demo.local");
  const [credential, setCredential] = useState("");
  const [error, setError] = useState("");

  const accept = useCallback(async (candidate: AuthUser) => {
    if (candidate.role === "owner") return setUser(candidate);
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
  if (user) return <OwnerSessionContext.Provider value={{ user, signOut }}>{children}</OwnerSessionContext.Provider>;

  return <main className="auth-page"><form className="auth-card" onSubmit={submit}>
    <p className="eyebrow">PHARMICA OWNER</p><h1>Sign in</h1>
    <label>Login<input autoComplete="username" value={login} onChange={(event) => setLogin(event.target.value)} /></label>
    <label>Password<input type="password" autoComplete="current-password" value={credential} onChange={(event) => setCredential(event.target.value)} /></label>
    {error && <p className="auth-error">{error}</p>}
    <button type="submit">Sign in</button>
  </form></main>;
}
