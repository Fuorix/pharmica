import { createContext, useContext, useSyncExternalStore } from "react";
import { DEVICE_TOKEN_HEADER, type ActivateDeviceResponse, type PosStaffMember } from "@pharmica/contracts";
import type { EngineState, PosEngine } from "./local/engine";

export const apiUrl = import.meta.env.VITE_API_URL;

export type PosDevice = ActivateDeviceResponse["device"];
type StoredDevice = { deviceToken: string; device: PosDevice };

const DEVICE_KEY = "pharmica_device";
/** Who is signed in on this tab. Survives refresh; Lock and closing the tab still require a PIN. */
const USER_KEY = "pharmica_pos_user";

// The device token is tiny and needed before the local database opens, so it lives in localStorage.
export function loadDevice(): StoredDevice | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    return raw ? JSON.parse(raw) as StoredDevice : null;
  } catch {
    return null;
  }
}

export function saveDevice(value: StoredDevice | null): void {
  try {
    if (value) localStorage.setItem(DEVICE_KEY, JSON.stringify(value));
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    // Without storage the counter asks for activation again on restart.
  }
}

export function loadSignedInUserId(): string | null {
  try {
    return sessionStorage.getItem(USER_KEY);
  } catch {
    return null;
  }
}

export function saveSignedInUserId(userId: string | null): void {
  try {
    if (userId) sessionStorage.setItem(USER_KEY, userId);
    else sessionStorage.removeItem(USER_KEY);
  } catch {
    // Without session storage a refresh asks for the PIN again.
  }
}

/** Calls the API with this counter's device token. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const device = loadDevice();
  if (device) headers.set(DEVICE_TOKEN_HEADER, device.deviceToken);
  return fetch(`${apiUrl}${path}`, { ...init, headers, credentials: "include", signal: init.signal ?? AbortSignal.timeout(10_000) });
}

export type PosSession = { user: PosStaffMember; device: PosDevice; engine: PosEngine; lock: () => void };

export const PosSessionContext = createContext<PosSession | null>(null);

export function usePosSession(): PosSession {
  const session = useContext(PosSessionContext);
  if (!session) throw new Error("usePosSession must be used inside AuthGate");
  return session;
}

/** Re-renders whenever the counter's local state changes (sales, stock, sync status). */
export function useEngineState(engine: PosEngine): EngineState {
  return useSyncExternalStore(engine.subscribe, engine.getState);
}
