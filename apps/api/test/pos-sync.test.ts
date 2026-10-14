import type { PosOperation, PosSnapshot, PosSyncResult } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { ledgerBalance } from "@pharmica/domain";
import { beforeEach, describe, expect, it } from "vitest";
import * as snapshotRoute from "../app/api/v1/pos/snapshot/route";
import * as syncRoute from "../app/api/v1/pos/sync/route";
import { call, resetDatabase, seedTenants } from "./helpers";

let t: Awaited<ReturnType<typeof seedTenants>>;
let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;
const at = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

beforeEach(async () => {
  await resetDatabase();
  t = await seedTenants();
});

async function sync(operations: unknown[], deviceToken = t.deviceA1.token): Promise<PosSyncResult[]> {
  const response = await call(syncRoute.POST, { method: "POST", deviceToken, body: { operations } });
  expect(response.status).toBe(200);
  return response.body.results as PosSyncResult[];
}

const batchQuantity = async (batchId: string) => (await db.batch.findUniqueOrThrow({ where: { id: batchId } })).quantity;
const batchB1 = async () => db.batch.findFirstOrThrow({ where: { productId: t.productA1.id } });

/** A cash sale of Panadol (10 strips x 10 tablets, PKR 100 a pack) from branch A1's only batch. */
async function saleOp(overrides: Partial<{ quantity: number; unit: "pack" | "strip" | "tablet"; unitPrice: number; discount: number; billDiscount: number; paymentMethod: "cash" | "card" | "credit"; customerId: string; shiftId: string; userId: string; total: number }> = {}): Promise<PosOperation> {
  const batch = await batchB1();
  const quantity = overrides.quantity ?? 2;
  const unitPrice = overrides.unitPrice ?? 100;
  const discount = overrides.discount ?? 0;
  const billDiscount = overrides.billDiscount ?? 0;
  return {
    id: nextId("op"),
    type: "sale",
    userId: overrides.userId ?? t.cashierA1.id,
    occurredAt: at(5),
    payload: {
      saleId: nextId("sale"),
      receiptNo: nextId("A1-"),
      shiftId: overrides.shiftId,
      customerId: overrides.customerId,
      paymentMethod: overrides.paymentMethod ?? "cash",
      billDiscount,
      total: overrides.total ?? quantity * unitPrice - discount - billDiscount,
      lines: [{ lineId: nextId("line"), productId: t.productA1.id, batchId: batch.id, unit: overrides.unit ?? "pack", quantity, unitPrice, discount }]
    }
  };
}

describe("POS snapshot", () => {
  it("gives the counter its branch's catalogue, batches, customers, and staff", async () => {
    await db.customer.create({ data: { branchId: t.branchA1.id, name: "Ali", creditLimit: 1000 } });
    await db.customer.create({ data: { branchId: t.branchA2.id, name: "Other branch" } });
    const response = await call(snapshotRoute.GET, { deviceToken: t.deviceA1.token });
    expect(response.status).toBe(200);
    const snapshot = response.body as unknown as PosSnapshot;
    expect(snapshot.device.branchId).toBe(t.branchA1.id);
    expect(snapshot.products.map((product) => product.id)).toEqual([t.productA1.id]);
    expect(snapshot.batches).toMatchObject([{ productId: t.productA1.id, quantity: 1000, retailPrice: 100 }]);
    expect(snapshot.customers.map((customer) => customer.name)).toEqual(["Ali"]);
    expect(snapshot.staff.map((member) => [member.name, member.maxDiscountPercent]).sort()).toEqual([["cashier-a1", 0], ["owner-a", null]]);
  });

  it("refuses a deactivated or unknown device", async () => {
    await db.device.update({ where: { id: t.deviceA1.id }, data: { isActive: false } });
    expect((await call(snapshotRoute.GET, { deviceToken: t.deviceA1.token })).status).toBe(401);
    expect((await call(syncRoute.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { operations: [] } })).status).toBe(401);
  });
});

describe("uploading offline sales", () => {
  it("records the sale exactly as rung up, takes the stock, and numbers the receipt", async () => {
    await db.user.update({ where: { id: t.cashierA1.id }, data: { maxDiscountPercent: 5 } });
    const operation = await saleOp({ quantity: 2, discount: 10 });
    const [result] = await sync([operation]);
    expect(result).toEqual({ id: operation.id, status: "applied" });

    const payload = (operation as Extract<PosOperation, { type: "sale" }>).payload;
    const sale = await db.sale.findUniqueOrThrow({ where: { id: payload.saleId }, include: { lines: true } });
    expect(sale).toMatchObject({ receiptNo: payload.receiptNo, deviceId: t.deviceA1.id, userId: t.cashierA1.id });
    expect([Number(sale.subtotal), Number(sale.discount), Number(sale.total)]).toEqual([200, 10, 190]);
    expect(sale.createdAt.toISOString()).toBe(operation.occurredAt);
    expect(sale.lines[0]).toMatchObject({ id: payload.lines[0].lineId, batchId: payload.lines[0].batchId });
    expect(await batchQuantity(payload.lines[0].batchId)).toBe(1000 - 200);
    expect(await db.stockMovement.count({ where: { type: "SALE", referenceId: sale.id } })).toBe(1);
  });

  it("applies a retried upload only once", async () => {
    const operation = await saleOp();
    await sync([operation]);
    const [again] = await sync([operation]);
    expect(again.status).toBe("duplicate");
    expect(await db.sale.count()).toBe(1);
    expect(await batchQuantity((await batchB1()).id)).toBe(1000 - 200);
  });

  it("rejects a price above the batch's printed retail price", async () => {
    const [result] = await sync([await saleOp({ unitPrice: 120 })]);
    expect(result).toMatchObject({ status: "failed", error: { code: "ABOVE_RETAIL_PRICE" } });
    expect(await db.sale.count()).toBe(0);
    expect(await db.syncOperation.count({ where: { status: "FAILED" } })).toBe(1);
  });

  it("rejects stock from another branch and users who may not work here", async () => {
    const other = await db.product.create({ data: { branchId: t.branchA2.id, name: "Elsewhere" } });
    const otherBatch = await db.batch.create({ data: { productId: other.id, batchNo: "X", quantity: 5, retailPrice: 10, expiryDate: new Date(Date.now() + 1e10) } });
    const foreign = await saleOp();
    const sale = foreign as Extract<PosOperation, { type: "sale" }>;
    sale.payload.lines[0] = { ...sale.payload.lines[0], productId: other.id, batchId: otherBatch.id, unitPrice: 10 };
    const [stockResult, userResult] = await sync([foreign, await saleOp({ userId: t.cashierA2.id })]);
    expect(stockResult.error?.code).toBe("UNKNOWN_STOCK");
    expect(userResult.error?.code).toBe("USER_NOT_ALLOWED");
  });

  it("keeps a sale that oversold stock between counters, and flags it", async () => {
    const batch = await batchB1();
    await db.batch.update({ where: { id: batch.id }, data: { quantity: 150 } });
    const [result] = await sync([await saleOp({ quantity: 2 })]);
    expect(result).toMatchObject({ status: "applied", flags: ["OVERSOLD"] });
    expect(await batchQuantity(batch.id)).toBe(0);
    expect(await db.auditLog.count({ where: { action: "stock.oversold" } })).toBe(1);
  });

  it("flags a discount above the cashier's limit without losing the sale", async () => {
    await db.user.update({ where: { id: t.cashierA1.id }, data: { maxDiscountPercent: 5 } });
    const [within] = await sync([await saleOp({ quantity: 2, billDiscount: 10 })]);
    const [over] = await sync([await saleOp({ quantity: 2, billDiscount: 30 })]);
    expect(within.flags).toBeUndefined();
    expect(over).toMatchObject({ status: "applied", flags: ["DISCOUNT_OVER_LIMIT"] });
    const [owner] = await sync([await saleOp({ quantity: 2, billDiscount: 100, userId: t.ownerA.id })]);
    expect(owner.flags).toBeUndefined();
  });

  it("records shifts with their closing report", async () => {
    const shiftId = nextId("shift");
    const results = await sync([
      { id: nextId("op"), type: "shift.open", userId: t.cashierA1.id, occurredAt: at(60), payload: { shiftId, openingCash: 5000 } },
      await saleOp({ shiftId }),
      { id: nextId("op"), type: "shift.close", userId: t.cashierA1.id, occurredAt: at(1), payload: { shiftId, closingCash: 5200, report: { expectedCash: 5200, variance: 0 } } }
    ]);
    expect(results.map((result) => result.status)).toEqual(["applied", "applied", "applied"]);
    const shift = await db.shift.findUniqueOrThrow({ where: { id: shiftId }, include: { sales: true } });
    expect(shift).toMatchObject({ status: "CLOSED", deviceId: t.deviceA1.id, closingReport: { expectedCash: 5200, variance: 0 } });
    expect(shift.sales).toHaveLength(1);
  });
});

describe("customers and credit", () => {
  it("creates an offline customer and books a credit sale to their ledger", async () => {
    const customerId = nextId("customer");
    const results = await sync([
      { id: nextId("op"), type: "customer.create", userId: t.cashierA1.id, occurredAt: at(10), payload: { customerId, name: "Bilal", phone: "03001234567", creditLimit: 5000 } },
      await saleOp({ paymentMethod: "credit", customerId })
    ]);
    expect(results.map((result) => result.status)).toEqual(["applied", "applied"]);
    expect(ledgerBalance(await db.customerLedgerEntry.findMany({ where: { customerId } }))).toBe(200);
  });

  it("refuses a credit sale without a customer", async () => {
    const [result] = await sync([await saleOp({ paymentMethod: "credit" })]);
    expect(result.status).toBe("failed");
  });
});

describe("voids and returns", () => {
  it("voids a sale, puts the stock back, and reverses credit", async () => {
    const customer = await db.customer.create({ data: { branchId: t.branchA1.id, name: "Ali" } });
    const sale = await saleOp({ paymentMethod: "credit", customerId: customer.id }) as Extract<PosOperation, { type: "sale" }>;
    const voidOp = { id: nextId("op"), type: "sale.void", userId: t.cashierA1.id, occurredAt: at(1), payload: { saleId: sale.payload.saleId, reason: "Wrong item" } };
    expect((await sync([sale, voidOp])).map((result) => result.status)).toEqual(["applied", "applied"]);

    expect(await db.sale.findUniqueOrThrow({ where: { id: sale.payload.saleId } })).toMatchObject({ status: "VOIDED", voidReason: "Wrong item", voidedById: t.cashierA1.id });
    expect(await batchQuantity(sale.payload.lines[0].batchId)).toBe(1000);
    expect(ledgerBalance(await db.customerLedgerEntry.findMany({ where: { customerId: customer.id } }))).toBe(0);
    const [twice] = await sync([{ ...voidOp, id: nextId("op") }]);
    expect(twice.error?.code).toBe("SALE_ALREADY_CHANGED");
  });

  it("returns part of a sale to its batch and refunds its share after discounts", async () => {
    const sale = await saleOp({ quantity: 4, billDiscount: 40 }) as Extract<PosOperation, { type: "sale" }>;
    const returnId = nextId("return");
    const results = await sync([sale, { id: nextId("op"), type: "sale.return", userId: t.cashierA1.id, occurredAt: at(1), payload: { returnId, saleId: sale.payload.saleId, reason: "Not needed", refundMethod: "cash", lines: [{ saleLineId: sale.payload.lines[0].lineId, quantity: 1 }] } }]);
    expect(results.map((result) => result.status)).toEqual(["applied", "applied"]);

    const saleReturn = await db.saleReturn.findUniqueOrThrow({ where: { id: returnId } });
    expect(Number(saleReturn.refundAmount)).toBe(90);
    expect(await batchQuantity(sale.payload.lines[0].batchId)).toBe(1000 - 300);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.payload.saleId } })).status).toBe("COMPLETED");
  });

  it("refuses to return more than was sold, and marks a fully returned sale", async () => {
    const sale = await saleOp({ quantity: 2 }) as Extract<PosOperation, { type: "sale" }>;
    const returning = (quantity: number) => ({ id: nextId("op"), type: "sale.return", userId: t.cashierA1.id, occurredAt: at(1), payload: { returnId: nextId("return"), saleId: sale.payload.saleId, reason: "Return", refundMethod: "cash", lines: [{ saleLineId: sale.payload.lines[0].lineId, quantity }] } });
    const results = await sync([sale, returning(3), returning(2), returning(1)]);
    expect(results.map((result) => result.error?.code ?? result.status)).toEqual(["applied", "INVALID_RETURN", "applied", "INVALID_RETURN"]);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.payload.saleId } })).status).toBe("RETURNED");
  });

  it("records counter events such as deleted lines in the audit log", async () => {
    const [result] = await sync([{ id: nextId("op"), type: "audit", userId: t.cashierA1.id, occurredAt: at(), payload: { action: "line_deleted", entityType: "cart", metadata: { product: "Panadol" } } }]);
    expect(result.status).toBe("applied");
    expect(await db.auditLog.findFirst({ where: { action: "pos.line_deleted" } })).toMatchObject({ userId: t.cashierA1.id, branchId: t.branchA1.id });
  });

  it("rejects malformed operations with a clear reason", async () => {
    const [result] = await sync([{ id: "bad-1", type: "sale", userId: t.cashierA1.id, occurredAt: at(), payload: { saleId: "s" } }]);
    expect(result).toMatchObject({ id: "bad-1", status: "failed", error: { code: "VALIDATION_FAILED" } });
  });
});
