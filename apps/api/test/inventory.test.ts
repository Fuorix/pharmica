import type { InventoryItem, PosSyncResult, PurchaseSummary } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { beforeEach, describe, expect, it } from "vitest";
import * as inventory from "../app/api/v1/inventory/route";
import * as ledger from "../app/api/v1/inventory/ledger/route";
import * as purchases from "../app/api/v1/purchases/route";
import * as syncRoute from "../app/api/v1/pos/sync/route";
import { ledgerMismatches } from "../src/inventory/stock";
import { call, resetDatabase, seedTenants, stockBatch, webSession } from "./helpers";

const DAY = 86_400_000;
const date = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
let t: Awaited<ReturnType<typeof seedTenants>>;
let owner: string;
let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

beforeEach(async () => {
  await resetDatabase();
  t = await seedTenants();
  owner = await webSession(t.ownerA.id);
});

/** Brufen: a master medicine (2 strips x 10) with an official price of PKR 330, not yet stocked in branch A1. */
async function brufenMaster() {
  const master = await db.masterProduct.create({ data: { name: "Brufen 400mg", generic: "Ibuprofen", company: "Abbott", unitsPerPack: 2, tabletsPerStrip: 10, officialRetailPrice: 330 } });
  await db.masterPriceHistory.create({ data: { masterProductId: master.id, price: 330, effectiveFrom: new Date(Date.now() - 30 * DAY), source: "SRO" } });
  return master;
}

function receive(body: object) {
  return call(purchases.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, supplier: { name: "Muller & Phipps" }, ...body } });
}

async function sync(operations: unknown[]): Promise<PosSyncResult[]> {
  const response = await call(syncRoute.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { operations } });
  return response.body.results as PosSyncResult[];
}

const op = (type: string, payload: object, userId = t.cashierA1.id) => ({ id: nextId("op"), type, userId, occurredAt: new Date().toISOString(), payload });

describe("receiving a supplier invoice", () => {
  it("creates batch stock at the real cost, with bonus packs and both discounts in the totals", async () => {
    const master = await brufenMaster();
    const response = await receive({
      invoiceNumber: "MP-1001", invoiceDate: date(-1), invoiceDiscount: 96,
      lines: [
        { masterProductId: master.id, batchNo: "BR-24", expiryDate: date(500), quantity: 10, bonusQuantity: 2, costPrice: 200, discount: 100, retailPrice: 330 },
        { productId: t.productA1.id, batchNo: "PN-9", expiryDate: date(400), quantity: 5, bonusQuantity: 0, costPrice: 100, discount: 0, retailPrice: 100 }
      ]
    });
    expect(response.status).toBe(201);
    const purchase = response.body.purchase as PurchaseSummary;
    expect(purchase).toMatchObject({ subtotal: 2500, lineDiscount: 100, invoiceDiscount: 96, total: 2304, bonusPacks: 2, invoiceNumber: "MP-1001" });
    expect(purchase.lines.map((line) => [line.name, line.quantity, line.bonusQuantity, line.effectiveCost])).toEqual([["Brufen 400mg", 10, 2, 152], ["Panadol 500mg", 5, 0, 96]]);

    const brufen = await db.product.findUniqueOrThrow({ where: { branchId_masterProductId: { branchId: t.branchA1.id, masterProductId: master.id } }, include: { batches: true } });
    expect(brufen.batches).toMatchObject([{ batchNo: "BR-24", quantity: 12 * 20 }]);
    expect(Number(brufen.batches[0].costPrice)).toBe(152);
    expect(await db.stockMovement.count({ where: { type: "RECEIPT", referenceId: purchase.id } })).toBe(2);
    const payable = await db.supplierLedgerEntry.findFirstOrThrow({ where: { purchaseId: purchase.id } });
    expect(Number(payable.amount)).toBe(2304);
  });

  it("tops up a batch already on the shelf at the average cost, keeping its printed price", async () => {
    const first = await receive({ invoiceDiscount: 0, lines: [{ productId: t.productA1.id, batchNo: "PN-9", expiryDate: date(400), quantity: 10, bonusQuantity: 0, costPrice: 80, discount: 0, retailPrice: 100 }] });
    expect(first.status).toBe(201);
    const second = await receive({ invoiceDiscount: 0, lines: [{ productId: t.productA1.id, batchNo: "PN-9", expiryDate: date(400), quantity: 30, bonusQuantity: 0, costPrice: 100, discount: 0, retailPrice: 110 }] });
    expect(second.body.warnings).toEqual([expect.stringContaining("already priced PKR 100.00")]);
    const batch = await db.batch.findFirstOrThrow({ where: { batchNo: "PN-9" } });
    expect([batch.quantity, Number(batch.costPrice), Number(batch.retailPrice)]).toEqual([40 * 100, 95, 100]);
  });

  it("reports a printed price that differs from the official master price, once", async () => {
    const master = await brufenMaster();
    const line = (batchNo: string, retailPrice: number) => ({ masterProductId: master.id, batchNo, expiryDate: date(500), quantity: 1, bonusQuantity: 0, costPrice: 200, discount: 0, retailPrice });
    const differing = await receive({ invoiceDiscount: 0, lines: [line("A", 350)] });
    expect(differing.body.warnings).toEqual([expect.stringContaining("differs from the master price PKR 330.00")]);
    await receive({ invoiceDiscount: 0, lines: [line("B", 350)] });
    await receive({ invoiceDiscount: 0, lines: [line("C", 330)] });
    const reports = await db.priceChangeReport.findMany();
    expect(reports.map((report) => [Number(report.oldPrice), Number(report.newPrice), report.source])).toEqual([[330, 350, "DISTRIBUTOR_INVOICE"]]);
    expect(reports[0].batchId).not.toBeNull();
  });

  it("refuses expired stock, and warns about near-expiry stock and repeated invoice numbers", async () => {
    const expired = await receive({ invoiceDiscount: 0, lines: [{ productId: t.productA1.id, batchNo: "OLD", expiryDate: date(-1), quantity: 1, bonusQuantity: 0, costPrice: 80, discount: 0, retailPrice: 100 }] });
    expect(expired.body.error?.code).toBe("EXPIRED_STOCK");
    const near = await receive({ invoiceNumber: "X-1", invoiceDiscount: 0, lines: [{ productId: t.productA1.id, batchNo: "NEAR", expiryDate: date(30), quantity: 1, bonusQuantity: 0, costPrice: 80, discount: 0, retailPrice: 100 }] });
    expect(near.body.warnings).toEqual([expect.stringContaining("expires within 90 days")]);
    const again = await receive({ invoiceNumber: "X-1", invoiceDiscount: 0, lines: [{ productId: t.productA1.id, batchNo: "NEAR2", expiryDate: date(300), quantity: 1, bonusQuantity: 0, costPrice: 80, discount: 0, retailPrice: 100 }] });
    expect(again.body.warnings).toEqual([expect.stringContaining("already received once")]);
  });

  it("validates lines", async () => {
    const response = await receive({ invoiceDiscount: 0, lines: [{ productId: t.productA1.id, batchNo: "Z", expiryDate: "2027-13-45", quantity: 1, costPrice: 80, retailPrice: 100 }] });
    expect(response.body.error?.code).toBe("VALIDATION_FAILED");
  });

  it("receives from a counter, offline-style, under the counter's own batch id", async () => {
    const master = await brufenMaster();
    const purchaseId = nextId("purchase");
    const [result] = await sync([op("purchase.receive", { purchaseId, supplier: { name: "Counter Supplier" }, invoiceDiscount: 0, lines: [{ masterProductId: master.id, batchId: "client-batch-1", batchNo: "BR-1", expiryDate: date(400), quantity: 2, bonusQuantity: 1, costPrice: 200, discount: 0, retailPrice: 330 }] })]);
    expect(result.status).toBe("applied");
    expect(await db.batch.findUniqueOrThrow({ where: { id: "client-batch-1" } })).toMatchObject({ quantity: 60 });
    expect(await db.purchase.findUniqueOrThrow({ where: { id: purchaseId } })).toMatchObject({ deviceId: t.deviceA1.id, userId: t.cashierA1.id });
  });
});

describe("stock adjustments and counts", () => {
  it("requires a reason and records every change in the audit log", async () => {
    const batch = await db.batch.findFirstOrThrow({ where: { productId: t.productA1.id } });
    expect((await call(inventory.PATCH, { method: "PATCH", token: owner, body: { batchId: batch.id, type: "DAMAGE", quantity: -10, reason: " " } })).status).toBe(400);
    const response = await call(inventory.PATCH, { method: "PATCH", token: owner, body: { batchId: batch.id, type: "DAMAGE", quantity: -10, reason: "Water damage" } });
    expect(response.body).toMatchObject({ batch: { quantity: 990 }, applied: -10 });
    expect(await db.auditLog.findFirst({ where: { action: "stock.damage" } })).toMatchObject({ entityId: batch.id });
    expect((await call(inventory.PATCH, { method: "PATCH", token: owner, body: { batchId: batch.id, type: "WRITE_OFF", quantity: 5, reason: "x" } })).body.error?.code).toBe("INVALID_QUANTITY");
  });

  it("never takes stock below zero; the counter is told what could not be removed", async () => {
    const batch = await db.batch.findFirstOrThrow({ where: { productId: t.productA1.id } });
    const [result] = await sync([op("stock.adjust", { adjustmentId: nextId("adj"), batchId: batch.id, type: "EXPIRY", quantity: -1200, reason: "Expired" })]);
    expect(result).toMatchObject({ status: "applied", flags: ["ADJUSTED_TO_AVAILABLE"] });
    expect((await db.batch.findUniqueOrThrow({ where: { id: batch.id } })).quantity).toBe(0);
  });

  it("applies only the difference a physical count found, keeping sales made elsewhere meanwhile", async () => {
    const batch = await db.batch.findFirstOrThrow({ where: { productId: t.productA1.id } });
    // The counter saw 1000 and counted 990; meanwhile another counter sold 100 (server now 900).
    await db.batch.update({ where: { id: batch.id }, data: { quantity: 900 } });
    await db.stockMovement.create({ data: { branchId: t.branchA1.id, productId: t.productA1.id, batchId: batch.id, userId: t.cashierA1.id, type: "SALE", quantity: -100, reason: "Sale" } });
    const [result] = await sync([op("stock.count", { countId: nextId("count"), reason: "Monthly count", lines: [{ batchId: batch.id, expected: 1000, counted: 990 }] })]);
    expect(result.status).toBe("applied");
    expect((await db.batch.findUniqueOrThrow({ where: { id: batch.id } })).quantity).toBe(890);
    expect(await db.stockMovement.findFirst({ where: { type: "COUNT" } })).toMatchObject({ quantity: -10 });
  });

  it("lets a counter set rack location and the low-stock alert", async () => {
    const [result] = await sync([op("product.update", { productId: t.productA1.id, rackLocation: "B-2", lowStockThreshold: 3 })]);
    expect(result.status).toBe("applied");
    expect(await db.product.findUniqueOrThrow({ where: { id: t.productA1.id } })).toMatchObject({ rackLocation: "B-2", lowStockThreshold: 3 });
  });
});

describe("inventory report and the stock ledger", () => {
  it("reports sellable, near-expiry, and expired stock, low stock, and stock value", async () => {
    await db.product.update({ where: { id: t.productA1.id }, data: { lowStockThreshold: 15 } });
    await stockBatch(t.productA1.id, { batchNo: "NEAR", quantity: 100, retailPrice: 100, costPrice: 70, expiryDate: new Date(Date.now() + 20 * DAY) });
    await stockBatch(t.productA1.id, { batchNo: "GONE", quantity: 50, retailPrice: 100, costPrice: 70, expiryDate: new Date(Date.now() - 5 * DAY) });
    const response = await call(inventory.GET, { path: `/api/v1/inventory?branchId=${t.branchA1.id}`, token: owner });
    const item = (response.body.items as InventoryItem[])[0];
    expect(item).toMatchObject({ sellable: 1100, nearExpiry: 100, expired: 50, lowStock: true, valueAtCost: 800 + 70 + 35, valueAtRetail: 1150 });
    expect(item.batches.map((batch) => [batch.batchNo, batch.status])).toEqual([["GONE", "expired"], ["NEAR", "near-expiry"], ["B-1", "ok"]]);
    const lowOnly = await call(inventory.GET, { path: `/api/v1/inventory?branchId=${t.branchA1.id}&status=expired`, token: owner });
    expect((lowOnly.body.items as InventoryItem[]).map((entry) => entry.productId)).toEqual([t.productA1.id]);
  });

  it("keeps every batch equal to its ledger through receipts, sales, voids, returns, write-offs, counts, and overselling", async () => {
    const master = await brufenMaster();
    await receive({ invoiceDiscount: 0, lines: [{ masterProductId: master.id, batchNo: "L-1", expiryDate: date(300), quantity: 3, bonusQuantity: 1, costPrice: 200, discount: 0, retailPrice: 330 }] });
    const batch = await db.batch.findFirstOrThrow({ where: { productId: t.productA1.id } });
    const sale = (saleId: string, quantity: number) => op("sale", { saleId, receiptNo: nextId("R"), paymentMethod: "cash", billDiscount: 0, total: quantity * 100, lines: [{ lineId: `${saleId}-line`, productId: t.productA1.id, batchId: batch.id, unit: "pack", quantity, unitPrice: 100, discount: 0 }] });
    await sync([
      sale("s1", 2),
      op("sale.void", { saleId: "s1", reason: "Mistake" }),
      sale("s2", 3),
      op("sale.return", { returnId: "r1", saleId: "s2", reason: "Back", refundMethod: "cash", lines: [{ saleLineId: "s2-line", quantity: 1 }] }),
      op("stock.adjust", { adjustmentId: "a1", batchId: batch.id, type: "WRITE_OFF", quantity: -15, reason: "Torn strips" }),
      op("stock.count", { countId: "c1", reason: "Count", lines: [{ batchId: batch.id, expected: 785, counted: 780 }] }),
      sale("s3", 9)
    ]);
    expect((await db.batch.findUniqueOrThrow({ where: { id: batch.id } })).quantity).toBe(0);
    expect(await ledgerMismatches(t.branchA1.id)).toEqual([]);
    const check = await call(ledger.GET, { path: `/api/v1/inventory/ledger?branchId=${t.branchA1.id}`, token: owner });
    expect(check.body).toEqual({ mismatches: [] });
    const history = await call(ledger.GET, { path: `/api/v1/inventory/ledger?productId=${t.productA1.id}`, token: owner });
    expect((history.body.movements as Array<{ type: string; batchBalance: number }>)[0]).toMatchObject({ batchBalance: 0 });
  });
});

describe("purchase list", () => {
  it("shows the owner recent purchases with their totals", async () => {
    await receive({ invoiceNumber: "MP-1", invoiceDiscount: 10, lines: [{ productId: t.productA1.id, batchNo: "Q", expiryDate: date(300), quantity: 2, bonusQuantity: 1, costPrice: 80, discount: 5, retailPrice: 100 }] });
    const response = await call(purchases.GET, { path: `/api/v1/purchases?branchId=${t.branchA1.id}`, token: owner });
    expect((response.body.purchases as PurchaseSummary[])[0]).toMatchObject({ invoiceNumber: "MP-1", subtotal: 160, lineDiscount: 5, invoiceDiscount: 10, total: 145, bonusPacks: 1, supplier: { name: "Muller & Phipps" } });
  });
});

