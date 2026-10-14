import type { DeviceDiagnostics, MasterListPage, PosSyncResult, SyncIssue } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as devices from "../app/api/v1/devices/route";
import * as diagnostics from "../app/api/v1/pos/diagnostics/route";
import * as masterList from "../app/api/v1/pos/master-list/route";
import * as syncRoute from "../app/api/v1/pos/sync/route";
import * as issues from "../app/api/v1/sync/issues/route";
import { processOperation } from "../src/pos/operations";
import { call, resetDatabase, seedTenants, webSession } from "./helpers";

let t: Awaited<ReturnType<typeof seedTenants>>;
let owner: string;
let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

beforeEach(async () => {
  await resetDatabase();
  t = await seedTenants();
  owner = await webSession(t.ownerA.id);
});
afterEach(() => { vi.restoreAllMocks(); });

const push = (operations: unknown[]) => call(syncRoute.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { operations } }).then((response) => response.body.results as PosSyncResult[]);
const batchQuantity = async () => (await db.batch.findFirstOrThrow({ where: { productId: t.productA1.id } })).quantity;

async function saleOp(quantity = 1) {
  const batch = await db.batch.findFirstOrThrow({ where: { productId: t.productA1.id } });
  const saleId = nextId("sale");
  return { id: nextId("op"), type: "sale", userId: t.cashierA1.id, occurredAt: new Date().toISOString(), payload: { saleId, receiptNo: nextId("R"), paymentMethod: "cash", billDiscount: 0, total: quantity * 100, lines: [{ lineId: `${saleId}-l`, productId: t.productA1.id, batchId: batch.id, unit: "pack", quantity, unitPrice: 100, discount: 0 }] } };
}

describe("uploads arriving together", () => {
  it("applies a sale once when a retry races the original upload", async () => {
    const sale = await saleOp(2);
    const results = (await Promise.all([push([sale]), push([sale]), push([sale])])).flat();
    expect(results.map((result) => result.status).sort()).toEqual(["applied", "duplicate", "duplicate"]);
    expect(await db.sale.count()).toBe(1);
    expect(await batchQuantity()).toBe(1000 - 200);
    expect(await db.stockMovement.count({ where: { type: "SALE" } })).toBe(1);
  });

  it("never marks an applied operation as failed afterwards", async () => {
    const sale = await saleOp();
    await push([sale]);
    // The cashier is deactivated, and the counter (not knowing it already succeeded) sends the sale again.
    await db.user.update({ where: { id: t.cashierA1.id }, data: { isActive: false } });
    const device = await db.device.findUniqueOrThrow({ where: { id: t.deviceA1.id }, include: { branch: true } });
    expect((await processOperation(device, sale)).status).toBe("failed");
    expect(await db.syncOperation.findUniqueOrThrow({ where: { idempotencyKey: sale.id } })).toMatchObject({ status: "APPLIED" });
  });

  it("asks the counter to retry, instead of rejecting, when the server itself has a problem", async () => {
    const sale = await saleOp();
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("deadlock detected"));
    const [first] = await push([sale]);
    expect(first).toMatchObject({ status: "retry", error: { code: "SERVER_BUSY" } });
    expect(await db.syncOperation.findUniqueOrThrow({ where: { idempotencyKey: sale.id } })).toMatchObject({ status: "PENDING" });
    const [second] = await push([sale]);
    expect(second.status).toBe("applied");
    expect(await db.sale.count()).toBe(1);
  });
});

describe("master list download", () => {
  it("pages through the list and resumes from the cursor, picking up later changes", async () => {
    for (let index = 1; index <= 5; index++) await db.masterProduct.create({ data: { name: `Medicine ${index}` } });
    const page = async (since?: string | null) => (await call(masterList.GET, { path: `/api/v1/pos/master-list?limit=2${since ? `&since=${since}` : ""}`, deviceToken: t.deviceA1.token })).body as unknown as MasterListPage;

    // The fixture already has one master product (Panadol), so there are six in all.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let round = 0; round < 10; round++) {
      const result = await page(cursor);
      seen.push(...result.products.map((product) => product.name));
      cursor = result.nextCursor;
      if (!result.hasMore) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);

    // Nothing new: an empty page that keeps the same cursor.
    expect(await page(cursor)).toMatchObject({ products: [], hasMore: false, nextCursor: cursor });

    // A price change makes that product come down again, and only that one.
    const changed = await db.masterProduct.findFirstOrThrow({ where: { name: "Medicine 2" } });
    await db.masterProduct.update({ where: { id: changed.id }, data: { officialRetailPrice: 99 } });
    expect((await page(cursor)).products.map((product) => [product.name, product.officialRetailPrice])).toEqual([["Medicine 2", 99]]);
  });

  it("needs an activated counter and a valid cursor", async () => {
    expect((await call(masterList.GET, { path: "/api/v1/pos/master-list" })).status).toBe(401);
    expect((await call(masterList.GET, { path: "/api/v1/pos/master-list?since=garbage", deviceToken: t.deviceA1.token })).status).toBe(400);
  });
});

describe("counter health and sync issues", () => {
  it("shows the owner each counter's reported sync health", async () => {
    const report: DeviceDiagnostics = { appVersion: "0.1.0", reportedAt: new Date().toISOString(), pending: 3, failed: 1, oldestPendingAt: new Date(Date.now() - 3_600_000).toISOString(), lastSyncAt: null, lastSnapshotAt: null, consecutiveFailures: 4, lastError: "Pharmica is unreachable", masterProducts: 94, localSales: 12 };
    expect((await call(diagnostics.POST, { method: "POST", deviceToken: t.deviceA1.token, body: report })).status).toBe(204);
    const listed = await call(devices.GET, { token: owner });
    expect((listed.body.devices as Array<{ id: string; diagnostics: DeviceDiagnostics | null }>).find((device) => device.id === t.deviceA1.id)?.diagnostics).toMatchObject({ pending: 3, failed: 1, consecutiveFailures: 4 });
  });

  it("lists flagged and rejected uploads for the owner until they are reviewed", async () => {
    await db.batch.updateMany({ where: { productId: t.productA1.id }, data: { quantity: 50 } });
    const oversold = await saleOp(1);
    const tampered = await saleOp(1);
    (tampered.payload.lines[0] as { unitPrice: number }).unitPrice = 999;
    tampered.payload.total = 999;
    const [flagged, rejected] = await push([oversold, tampered]);
    expect(flagged.flags).toEqual(["OVERSOLD"]);
    expect(rejected.status).toBe("failed");

    const open = await call(issues.GET, { path: `/api/v1/sync/issues?branchId=${t.branchA1.id}`, token: owner });
    const list = open.body.issues as SyncIssue[];
    expect(list.map((issue) => [issue.status, issue.flags, issue.summary.startsWith("Receipt"), issue.userName, issue.deviceName]).sort()).toEqual([
      ["flagged", ["OVERSOLD"], true, "cashier-a1", "pos-a1"],
      ["rejected", [], true, "cashier-a1", "pos-a1"]
    ]);

    expect((await call(issues.PATCH, { method: "PATCH", token: owner, body: { operationId: oversold.id, note: "Counted the shelf; stock corrected" } })).status).toBe(204);
    expect(((await call(issues.GET, { path: `/api/v1/sync/issues?branchId=${t.branchA1.id}`, token: owner })).body.issues as SyncIssue[]).map((issue) => issue.id)).toEqual([tampered.id]);
    const all = (await call(issues.GET, { path: `/api/v1/sync/issues?branchId=${t.branchA1.id}&state=all`, token: owner })).body.issues as SyncIssue[];
    expect(all.find((issue) => issue.id === oversold.id)).toMatchObject({ reviewedBy: "owner-a", reviewNote: "Counted the shelf; stock corrected" });
  });

  it("keeps sync issues inside the owner's own pharmacy", async () => {
    const ownerB = await webSession(t.ownerB.id);
    expect((await call(issues.GET, { path: `/api/v1/sync/issues?branchId=${t.branchA1.id}`, token: ownerB })).status).toBe(403);
  });
});
