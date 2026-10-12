import { useCallback, useEffect, useState } from "react";
import type { SubscriptionStatus } from "@pharmica/contracts";
import { apiFetch, errorMessage, jsonBody } from "./session";

export const money = (value: number) => `PKR ${value.toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
export const day = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString("en-PK", { dateStyle: "medium" }) : "—";
export const dateTime = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" }) : "—";
export const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 120) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
};

/** Loads JSON from the API and reloads when the path changes. */
export function useApi<T>(path: string | null): { data: T | null; error: string; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const response = await apiFetch(path);
      if (response.ok) { setData(await response.json() as T); setError(""); } else setError(await errorMessage(response, "Could not load"));
    } catch {
      setError("Cannot reach the Pharmica API.");
    }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}

/** Sends a change and returns the parsed body, or throws the API error message. */
export async function send<T = Record<string, unknown>>(path: string, method: string, body: unknown): Promise<T> {
  const response = await apiFetch(path, { method, ...jsonBody(body) });
  if (!response.ok) throw new Error(await errorMessage(response, "Request failed"));
  return await response.json() as T;
}

const statusText: Record<SubscriptionStatus, string> = { TRIAL: "Trial", ACTIVE: "Active", GRACE: "Grace", EXPIRED: "Expired", CANCELLED: "Cancelled" };

export function StatusChip({ status }: { status: SubscriptionStatus | null }) {
  return <span className={`chip ${status ? status.toLowerCase() : "none"}`}>{status ? statusText[status] : "No plan"}</span>;
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return <div className="tabs">{options.map(([key, label]) => <button key={key} className={value === key ? "active" : ""} onClick={() => onChange(key)}>{label}</button>)}</div>;
}

export function Message({ text }: { text: string }) {
  return text ? <p className={text.startsWith("✓") ? "message ok" : "message"}>{text}</p> : null;
}
