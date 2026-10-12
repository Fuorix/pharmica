import { DEVICE_TOKEN_HEADER, type DeviceDiagnostics, type MasterListPage, type MasterProductSummary, type PosOperation, type PosSnapshot, type PosSyncResult } from "@pharmica/contracts";
import { DeviceRevokedError, OfflineError, SyncPausedError, type Transport } from "./engine";

/** Talks to the API with the counter's device token, so uploads work whether or not anyone is signed in. */
export function httpTransport(apiUrl: string, deviceToken: string): Transport {
  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${path}`, { ...init, headers: { ...init.headers, [DEVICE_TOKEN_HEADER]: deviceToken }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new OfflineError("Pharmica is unreachable");
    }
    if (response.status === 401) throw new DeviceRevokedError("This counter was deactivated or reset by the owner");
    if (response.status >= 500 || response.status === 0) throw new OfflineError(`Server error ${response.status}`);
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      if (response.status === 402 || body?.error?.code === "ORGANISATION_SUSPENDED") throw new SyncPausedError(body?.error?.message ?? "Sync is paused");
      throw new Error(body?.error?.message ?? `Sync failed (${response.status})`);
    }
    return response;
  }

  return {
    async snapshot() {
      return await (await send("/api/v1/pos/snapshot")).json() as PosSnapshot;
    },
    async searchMaster(query: string) {
      return (await (await send(`/api/v1/pos/master?q=${encodeURIComponent(query)}`)).json() as { products: MasterProductSummary[] }).products;
    },
    async masterList(since: string | null) {
      return await (await send(`/api/v1/pos/master-list${since ? `?since=${encodeURIComponent(since)}` : ""}`)).json() as MasterListPage;
    },
    async reportDiagnostics(report: DeviceDiagnostics) {
      await send("/api/v1/pos/diagnostics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
    },
    async push(operations: PosOperation[]) {
      const response = await send("/api/v1/pos/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operations }) });
      return (await response.json() as { results: PosSyncResult[] }).results;
    }
  };
}
