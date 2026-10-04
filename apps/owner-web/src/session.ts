import { createContext, useContext } from "react";
import type { AuthUser } from "@pharmica/contracts";

export const apiUrl = import.meta.env.VITE_API_URL;

/** Calls the API with the owner's session cookie. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiUrl}${path}`, { ...init, credentials: "include" });
}

export function jsonBody(body: unknown): RequestInit {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

export type OwnerSession = { user: AuthUser; signOut: () => void };

export const OwnerSessionContext = createContext<OwnerSession | null>(null);

export function useOwnerSession(): OwnerSession {
  const session = useContext(OwnerSessionContext);
  if (!session) throw new Error("useOwnerSession must be used inside AuthGate");
  return session;
}
