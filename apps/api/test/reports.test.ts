import type { CashBookDay, DashboardResponse, ExpenseItem, PosSnapshot, PriceUpdate, ProfitAndLoss, SalesReportRow, StockHealthItem } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { beforeEach, describe, expect, it } from "vitest";
import * as branchesRoute from "../app/api/v1/branches/route";
import * as priceUpdatesRoute from "../app/api/v1/catalogue/price-updates/route";
import * as expensesRoute from "../app/api/v1/expenses/route";
import * as exportRoute from "../app/api/v1/export/route";
import * as snapshotRoute from "../app/api/v1/pos/snapshot/route";
import * as syncRoute from "../app/api/v1/pos/sync/route";
import * as cashBookRoute from "../app/api/v1/reports/cash-book/route";
import * as dashboardRoute from "../app/api/v1/reports/dashboard/route";
import * as profitLossRoute from "../app/api/v1/reports/profit-loss/route";
import * as salesRoute from "../app/api/v1/reports/sales/route";
import * as shiftsRoute from "../app/api/v1/reports/shifts/route";
import * as stockHealthRoute from "../app/api/v1/reports/stock-health/route";
import { pkDay } from "../src/reports/period";
import { call, resetDatabase, seedTenants, stockBatch, webSession } from "./helpers";

let t: Awaited<ReturnType<typeof seedTenants>>;
let owner: string;
let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;
const DAY_MS = 86_400_000;

beforeEach(async () => {
  await resetDatabase();
  t = await seedTenants();
  owner = await webSession(t.ownerA.id);
});

async function sync(operations: unknown[]) {
  const response = await call(syncRoute.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { operations } });
  expect(response.status).toBe(200);
  expect((response.body.results as Array<{ status: string }>).every((result) => result.status === "applied")).toBe(true);
}

/** A sale of Panadol (10 strips x 10 tablets, PKR 100 a pack, cost PKR 80 a pack) at an exact instant. */
async function sale(occurredAt: string, options: { unit?: "pack" | "strip"; quantity?: number; billDiscount?: number; paymentMethod?: "cash" | "card" } = {}) {
  const batch = await db.batch.findFirstOrThrow({ where: { productId: t.productA1.id } });
  const unit = options.unit ?? "pack";
  const quantity = options.quantity ?? 2;
  const unitPrice = unit === "pack" ? 100 : 10;
  const billDiscount = options.billDiscount ?? 0;
  const saleId = nextId("sale");
  const lineId = nextId("line");
  await sync([{
    id: nextId("op"), type: "sale", userId: t.cashierA1.id, occurredAt,
    payload: { saleId, receiptNo: nextId("A1-"), paymentMethod: options.paymentMethod ?? "cash", billDiscount, total: quantity * unitPrice - billDiscount, lines: [{ lineId, productId: t.productA1.id, batchId: batch.id, unit, quantity, unitPrice, discount: 0 }] }
  }]);
  return { saleId, lineId };
}

const get = (handler: typeof salesRoute.GET, path: string, token = owner) => call(handler, { path, token });

describe("sales and profit reports", () => {
  it("adds up revenue, cost, discounts, returns, and profit after expenses", async () => {
    const first = await sale("2026-10-01T06:00:00.000Z", { quantity: 2, billDiscount: 20 });
    await sale("2026-10-01T07:00:00.000Z", { unit: "strip", quantity: 3, paymentMethod: "card" });
    await sync([{ id: nextId("op"), type: "sale.return", userId: t.cashierA1.id, occurredAt: "2026-10-01T08:00:00.000Z", payload: { returnId: nextId("ret"), saleId: first.saleId, reason: "Not needed", refundMethod: "cash", lines: [{ saleLineId: first.lineId, quantity: 1 }] } }]);
    expect((await call(expensesRoute.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, category: "Electricity", amount: 50, day: "2026-10-01" } })).status).toBe(201);

    const report = await get(salesRoute.GET, `/api/v1/reports/sales?branchId=${t.branchA1.id}&from=2026-10-01&to=2026-10-01&groupBy=payment`);
    expect(report.status).toBe(200);
    // Revenue: 200 - 20 bill discount + 30 strips - 90 refunded. Cost: 160 + 24 - 80.
    expect(report.body.totals).toMatchObject({ revenue: 120, cost: 104, grossProfit: 16, discounts: 20, returns: 90, bills: 2, revenueWithoutCost: 0 });
    const rows = report.body.rows as SalesReportRow[];
    expect(rows.map((row) => [row.key, row.revenue])).toEqual([["cash", 90], ["card", 30]]);

    const pnl = (await get(profitLossRoute.GET, `/api/v1/reports/profit-loss?branchId=${t.branchA1.id}&from=2026-10-01&to=2026-10-01`)).body.profitAndLoss as ProfitAndLoss;
    expect(pnl).toMatchObject({ revenue: 120, costOfGoods: 104, grossProfit: 16, expenses: 50, stockLosses: 0, netProfit: -34, expensesByCategory: [{ category: "Electricity", amount: 50 }] });

    const days = (await get(cashBookRoute.GET, `/api/v1/reports/cash-book?branchId=${t.branchA1.id}&from=2026-10-01&to=2026-10-01`)).body.days as CashBookDay[];
    expect(days).toEqual([{ day: "2026-10-01", cashSales: 180, repayments: 0, refunds: 90, expenses: 50, supplierPayments: 0, net: 40 }]);
  });

  it("leaves sales with an unknown cost out of profit instead of counting them as free", async () => {
    const { saleId } = await sale("2026-10-01T06:00:00.000Z");
    await db.saleLine.updateMany({ where: { saleId }, data: { unitCost: null } });
    const totals = (await get(salesRoute.GET, `/api/v1/reports/sales?branchId=${t.branchA1.id}&from=2026-10-01`)).body.totals;
    expect(totals).toMatchObject({ revenue: 200, cost: 0, grossProfit: 0, marginPercent: null, revenueWithoutCost: 200 });
  });

  it("splits days at midnight Pakistan time, not UTC", async () => {
    await sale("2026-10-01T18:59:00.000Z"); // 23:59 on 1 October in Karachi
    await sale("2026-10-01T19:01:00.000Z"); // 00:01 on 2 October in Karachi
    const byDay = (await get(salesRoute.GET, `/api/v1/reports/sales?branchId=${t.branchA1.id}&from=2026-10-01&to=2026-10-02&groupBy=day`)).body.rows as SalesReportRow[];
    expect(byDay.map((row) => [row.key, row.bills])).toEqual([["2026-10-01", 1], ["2026-10-02", 1]]);
    const oneDay = await get(salesRoute.GET, `/api/v1/reports/sales?branchId=${t.branchA1.id}&from=2026-10-02&to=2026-10-02`);
    expect(oneDay.body.totals).toMatchObject({ bills: 1, revenue: 200 });
    expect(pkDay(new Date("2026-10-01T19:00:00.000Z"))).toBe("2026-10-02");
  });

  it("reports every branch together or one at a time, and only the owner's own", async () => {
    await sale("2026-10-01T06:00:00.000Z");
    const all = await get(salesRoute.GET, "/api/v1/reports/sales?branchId=all&from=2026-10-01&groupBy=branch");
    expect(all.status).toBe(200);
    expect((all.body.branches as Array<{ name: string }>).map((branch) => branch.name)).toEqual(["A1", "A2"]);
    expect((all.body.rows as SalesReportRow[]).map((row) => [row.label, row.revenue])).toEqual([["A1", 200]]);

    const other = await get(salesRoute.GET, `/api/v1/reports/sales?branchId=${t.branchA2.id}&from=2026-10-01`);
    expect(other.body.totals).toMatchObject({ revenue: 0, bills: 0 });

    const ownerB = await webSession(t.ownerB.id);
    expect((await get(salesRoute.GET, `/api/v1/reports/sales?branchId=${t.branchA1.id}`, ownerB)).status).toBe(403);
    const theirs = await get(salesRoute.GET, "/api/v1/reports/sales?from=2026-10-01", ownerB);
    expect(theirs.body.totals).toMatchObject({ revenue: 0 });
    expect((await get(salesRoute.GET, `/api/v1/reports/sales?branchId=${t.branchA1.id}`, await webSession(t.cashierA1.id))).status).toBe(403);
  });

  it("rejects bad periods and groupings", async () => {
    expect((await get(salesRoute.GET, "/api/v1/reports/sales?from=2026-10-05&to=2026-10-01")).body.error?.code).toBe("INVALID_PERIOD");
    expect((await get(salesRoute.GET, "/api/v1/reports/sales?from=12-10-2026")).body.error?.code).toBe("INVALID_PERIOD");
    expect((await get(salesRoute.GET, "/api/v1/reports/sales?from=2024-01-01&to=2026-01-01")).body.error?.code).toBe("PERIOD_TOO_LONG");
    expect((await get(salesRoute.GET, "/api/v1/reports/sales?groupBy=colour")).body.error?.code).toBe("INVALID_GROUP");
  });

  it("gives zeros, not errors, for a new shop", async () => {
    const dashboard = await get(dashboardRoute.GET, `/api/v1/reports/dashboard?branchId=${t.branchA2.id}`);
    expect(dashboard.status).toBe(200);
    const body = dashboard.body as unknown as DashboardResponse;
    expect(body.totals).toMatchObject({ revenue: 0, bills: 0, marginPercent: null });
    expect(body.branches).toMatchObject([{ branchName: "A2", cashInDrawer: null, openShifts: 0, lowStock: 0 }]);
    expect(body.last7Days).toHaveLength(7);
    expect(body.topItems).toEqual([]);
    expect((await get(shiftsRoute.GET, `/api/v1/reports/shifts?branchId=${t.branchA2.id}`)).body.shifts).toEqual([]);
    const pnl = (await get(profitLossRoute.GET, `/api/v1/reports/profit-loss?branchId=${t.branchA2.id}`)).body.profitAndLoss as ProfitAndLoss;
    expect(pnl).toMatchObject({ revenue: 0, netProfit: 0, expensesByCategory: [] });
  });

  it("shows today's sales and the cash in an open drawer on the dashboard", async () => {
    const shiftId = nextId("shift");
    const now = new Date().toISOString();
    await sync([{ id: nextId("op"), type: "shift.open", userId: t.cashierA1.id, occurredAt: now, payload: { shiftId, openingCash: 500 } }]);
    const batch = await db.batch.findFirstOrThrow({ where: { productId: t.productA1.id } });
    await sync([{ id: nextId("op"), type: "sale", userId: t.cashierA1.id, occurredAt: now, payload: { saleId: nextId("sale"), receiptNo: nextId("A1-"), shiftId, paymentMethod: "cash", billDiscount: 0, total: 100, lines: [{ lineId: nextId("line"), productId: t.productA1.id, batchId: batch.id, unit: "pack", quantity: 1, unitPrice: 100, discount: 0 }] } }]);

    const body = (await get(dashboardRoute.GET, "/api/v1/reports/dashboard")).body as unknown as DashboardResponse;
    expect(body.totals).toMatchObject({ revenue: 100, grossProfit: 20, bills: 1 });
    expect(body.branches.find((branch) => branch.branchName === "A1")).toMatchObject({ cashInDrawer: 600, openShifts: 1 });
    expect(body.topItems).toMatchObject([{ name: "Panadol 500mg", revenue: 100 }]);
  });
});

describe("stock health and price updates", () => {
  it("finds stock that has not sold for months and items about to run out", async () => {
    await db.product.update({ where: { id: t.productA1.id }, data: { createdAt: new Date(Date.now() - 120 * DAY_MS) } });
    const fast = await db.product.create({ data: { branchId: t.branchA1.id, name: "Brufen 400", unitsPerPack: 10, tabletsPerStrip: 10, isShopSpecific: true } });
    await stockBatch(fast.id, { batchNo: "F-1", expiryDate: new Date(Date.now() + 365 * DAY_MS), quantity: 300, retailPrice: 100, costPrice: 70 });
    const batch = await db.batch.findFirstOrThrow({ where: { productId: fast.id } });
    // 2 packs sold yesterday: 200 tablets in 30 days is about 6.67 a day, so 100 left lasts 14 days.
    await sync([{ id: nextId("op"), type: "sale", userId: t.cashierA1.id, occurredAt: new Date(Date.now() - DAY_MS).toISOString(), payload: { saleId: nextId("sale"), receiptNo: nextId("A1-"), paymentMethod: "cash", billDiscount: 0, total: 200, lines: [{ lineId: nextId("line"), productId: fast.id, batchId: batch.id, unit: "pack", quantity: 2, unitPrice: 100, discount: 0 }] } }]);

    const items = (await get(stockHealthRoute.GET, `/api/v1/reports/stock-health?branchId=${t.branchA1.id}&coverDays=20`)).body.items as StockHealthItem[];
    expect(items.map((item) => [item.name, item.reason])).toEqual([["Panadol 500mg", "dead"], ["Brufen 400", "reorder"]]);
    expect(items[0]).toMatchObject({ sellable: 1000, valueAtCost: 800, lastSoldAt: null });
    expect(items[1]).toMatchObject({ sellable: 100, daysOfCover: 14, suggestedPacks: 1 });

    expect((await get(stockHealthRoute.GET, "/api/v1/reports/stock-health?branchId=all")).body.error?.code).toBe("BRANCH_REQUIRED");
  });

  it("lists official price changes for stocked medicines, including scheduled ones", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: t.productA1.id } });
    await db.masterPriceHistory.createMany({ data: [
      { masterProductId: product.masterProductId!, price: 100, effectiveFrom: new Date(Date.now() - 200 * DAY_MS), source: "SRO" },
      { masterProductId: product.masterProductId!, price: 110, effectiveFrom: new Date(Date.now() + 5 * DAY_MS), source: "SRO", reference: "SRO 1234(I)/2026" }
    ] });
    const updates = (await get(priceUpdatesRoute.GET, `/api/v1/catalogue/price-updates?branchId=${t.branchA1.id}`)).body.updates as PriceUpdate[];
    expect(updates).toMatchObject([{ name: "Panadol 500mg", oldPrice: 100, newPrice: 110, scheduled: true, reference: "SRO 1234(I)/2026", packsAtOtherPrices: 10 }]);
  });
});

describe("expenses", () => {
  it("records, lists, and deletes expenses with an audit trail", async () => {
    const created = await call(expensesRoute.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, category: "Rent", amount: 25000, paidFrom: "bank", note: "October" } });
    expect(created.status).toBe(201);
    const expense = created.body.expense as ExpenseItem;
    expect(expense).toMatchObject({ category: "Rent", amount: 25000, paidFrom: "bank", recordedBy: "owner-a" });

    const listed = await get(expensesRoute.GET, "/api/v1/expenses?branchId=all");
    expect((listed.body.expenses as ExpenseItem[]).map((item) => item.id)).toEqual([expense.id]);

    expect((await call(expensesRoute.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, category: "Tea", amount: 0 } })).status).toBe(400);
    expect((await call(expensesRoute.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, category: "Tea", amount: 10, day: "2099-01-01" } })).body.error?.code).toBe("INVALID_DATE");

    const ownerB = await webSession(t.ownerB.id);
    expect((await call(expensesRoute.POST, { method: "POST", token: ownerB, body: { branchId: t.branchA1.id, category: "Rent", amount: 10 } })).status).toBe(403);
    expect((await call(expensesRoute.DELETE, { method: "DELETE", token: ownerB, body: { id: expense.id } })).status).toBe(404);

    expect((await call(expensesRoute.DELETE, { method: "DELETE", token: owner, body: { id: expense.id } })).status).toBe(200);
    expect(await db.expense.count()).toBe(0);
    expect(await db.auditLog.findMany({ where: { entityId: expense.id }, select: { action: true }, orderBy: { createdAt: "asc" } })).toEqual([{ action: "expense.recorded" }, { action: "expense.deleted" }]);
  });
});

describe("branch settings", () => {
  it("lets the owner set receipt text and alert windows, and sends the receipt text to the counter", async () => {
    const updated = await call(branchesRoute.PATCH, { method: "PATCH", token: owner, body: { branchId: t.branchA1.id, address: "Main Boulevard, Lahore", phone: "042-111", settings: { receiptHeader: "NTN 1234567", nearExpiryDays: 60 } } });
    expect(updated.status).toBe(200);
    expect(updated.body.branch).toMatchObject({ address: "Main Boulevard, Lahore", settings: { receiptHeader: "NTN 1234567", nearExpiryDays: 60, overdueDays: 30, receiptFooter: "Medicines are returned only with this receipt." } });

    await call(branchesRoute.PATCH, { method: "PATCH", token: owner, body: { branchId: t.branchA1.id, settings: { overdueDays: 45 } } });
    const listed = (await get(branchesRoute.GET, "/api/v1/branches")).body.branches as Array<{ id: string; settings: Record<string, unknown> }>;
    expect(listed.find((branch) => branch.id === t.branchA1.id)?.settings).toMatchObject({ receiptHeader: "NTN 1234567", nearExpiryDays: 60, overdueDays: 45 });

    const snapshot = (await call(snapshotRoute.GET, { deviceToken: t.deviceA1.token })).body as unknown as PosSnapshot;
    expect(snapshot.receipt).toEqual({ header: "NTN 1234567", footer: "Medicines are returned only with this receipt.", address: "Main Boulevard, Lahore", phone: "042-111" });

    expect((await call(branchesRoute.PATCH, { method: "PATCH", token: owner, body: { branchId: t.branchA1.id, settings: { nearExpiryDays: 0 } } })).status).toBe(400);
    expect((await call(branchesRoute.PATCH, { method: "PATCH", token: await webSession(t.ownerB.id), body: { branchId: t.branchA1.id, phone: "x" } })).status).toBe(403);
  });
});

describe("data export", () => {
  it("exports the organisation's data without any secret", async () => {
    await sale("2026-10-01T06:00:00.000Z");
    const response = await exportRoute.GET(new Request("http://localhost:4000/api/v1/export", { headers: { authorization: `Bearer ${owner}` } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="pharmica-export-/);
    const text = await response.text();
    const data = JSON.parse(text) as Record<string, Array<Record<string, unknown>>>;

    expect(data.branches.map((branch) => branch.name)).toEqual(["A1", "A2"]);
    expect(data.sales).toHaveLength(1);
    expect(data.saleLines[0]).toMatchObject({ unitCost: "80" });
    expect(data.users.every((user) => !("credentialHash" in user) && !("pinHash" in user))).toBe(true);
    expect(data.devices.every((device) => !("secretHash" in device))).toBe(true);
    expect(data).not.toHaveProperty("sessions");
    for (const secret of [...(await db.user.findMany()).flatMap((user) => [user.credentialHash, user.pinHash]), ...(await db.device.findMany()).map((device) => device.secretHash)]) {
      if (secret) expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("Org B");
    expect(text).not.toContain(t.branchB1.id);
  });

  it("exports one table as CSV", async () => {
    await sale("2026-10-01T06:00:00.000Z");
    const response = await exportRoute.GET(new Request("http://localhost:4000/api/v1/export?entity=sales&format=csv", { headers: { authorization: `Bearer ${owner}` } }));
    expect(response.headers.get("content-type")).toContain("text/csv");
    const [header, row] = (await response.text()).replace(/^\uFEFF/, "").split("\r\n");
    expect(header.split(",")).toContain("receiptNo");
    expect(row.split(",")[header.split(",").indexOf("total")]).toBe("200");

    const missing = await exportRoute.GET(new Request("http://localhost:4000/api/v1/export?format=csv", { headers: { authorization: `Bearer ${owner}` } }));
    expect(missing.status).toBe(400);
  });
});
