import type { ControlledRegisterEntry, LedgerLine, PayableSummary, PosSyncResult, ReceivableSummary } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { beforeEach, describe, expect, it } from "vitest";
import * as controlled from "../app/api/v1/controlled-drugs/route";
import * as customerLedger from "../app/api/v1/customers/[id]/ledger/route";
import * as customers from "../app/api/v1/customers/route";
import * as syncRoute from "../app/api/v1/pos/sync/route";
import * as supplierLedger from "../app/api/v1/suppliers/[id]/ledger/route";
import * as suppliers from "../app/api/v1/suppliers/route";
import { call, deviceSession, resetDatabase, seedTenants, stockBatch, webSession } from "./helpers";

const DAY = 86_400_000;
let t: Awaited<ReturnType<typeof seedTenants>>;
let owner: string;
let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;
const op = (type: string, payload: object, occurredAt = new Date().toISOString()) => ({ id: nextId("op"), type, userId: t.cashierA1.id, occurredAt, payload });

async function sync(operations: unknown[]): Promise<PosSyncResult[]> {
  return (await call(syncRoute.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { operations } })).body.results as PosSyncResult[];
}

beforeEach(async () => {
  await resetDatabase();
  t = await seedTenants();
  owner = await webSession(t.ownerA.id);
});

/** A cash or credit sale of Panadol (PKR 100 a pack) from branch A1's batch. */
async function saleOp(options: { quantity?: number; customerId?: string; prescription?: object; productId?: string; batchId?: string; unitPrice?: number } = {}) {
  const batch = options.batchId ?? (await db.batch.findFirstOrThrow({ where: { productId: t.productA1.id } })).id;
  const saleId = nextId("sale");
  const quantity = options.quantity ?? 1;
  const unitPrice = options.unitPrice ?? 100;
  return op("sale", {
    saleId, receiptNo: nextId("R"), paymentMethod: options.customerId ? "credit" : "cash", customerId: options.customerId, billDiscount: 0, total: quantity * unitPrice,
    lines: [{ lineId: `${saleId}-line`, productId: options.productId ?? t.productA1.id, batchId: batch, unit: "pack", quantity, unitPrice, discount: 0 }],
    ...(options.prescription ? { prescription: options.prescription } : {})
  });
}

describe("customer credit (khata)", () => {
  it("books a credit sale exactly once, even when the counter sends it twice", async () => {
    const customer = await db.customer.create({ data: { branchId: t.branchA1.id, name: "Ali", creditLimit: 5000 } });
    const sale = await saleOp({ customerId: customer.id, quantity: 3 });
    await sync([sale]);
    expect((await sync([sale]))[0].status).toBe("duplicate");
    const ledger = await call(customerLedger.GET, { token: owner, params: { id: customer.id } });
    expect((ledger.body.entries as LedgerLine[]).map((entry) => [entry.type, entry.amount])).toEqual([["CREDIT_SALE", 300]]);
    expect(ledger.body.customer).toMatchObject({ balance: 300 });
  });

  it("takes repayments at the counter, traceable to the cashier, device, shift, and time", async () => {
    const customer = await db.customer.create({ data: { branchId: t.branchA1.id, name: "Ali" } });
    await sync([await saleOp({ customerId: customer.id, quantity: 5 })]);
    const paidAt = new Date(Date.now() - 60_000).toISOString();
    const [result] = await sync([op("customer.payment", { paymentId: nextId("pay"), customerId: customer.id, amount: 200, method: "cash", shiftId: "shift-1" }, paidAt)]);
    expect(result.status).toBe("applied");
    const payment = await db.customerLedgerEntry.findFirstOrThrow({ where: { type: "PAYMENT" } });
    expect(payment).toMatchObject({ userId: t.cashierA1.id, deviceId: t.deviceA1.id, shiftId: "shift-1", paymentMethod: "CASH" });
    expect(payment.createdAt.toISOString()).toBe(paidAt);
    expect((await call(customerLedger.GET, { token: owner, params: { id: customer.id } })).body.customer).toMatchObject({ balance: 300 });
  });

  it("lets only the owner adjust a balance, and only with a reason", async () => {
    const customer = await db.customer.create({ data: { branchId: t.branchA1.id, name: "Ali" } });
    const cashier = await deviceSession(t.cashierA1.id, t.deviceA1.id);
    expect((await call(customerLedger.POST, { method: "POST", token: cashier, params: { id: customer.id }, body: { type: "ADJUSTMENT", amount: -50, reason: "Goodwill" } })).status).toBe(403);
    expect((await call(customerLedger.POST, { method: "POST", token: owner, params: { id: customer.id }, body: { type: "ADJUSTMENT", amount: -50, reason: " " } })).status).toBe(400);
    const adjusted = await call(customerLedger.POST, { method: "POST", token: owner, params: { id: customer.id }, body: { type: "ADJUSTMENT", amount: 75, reason: "Old khata carried over" } });
    expect(adjusted.status).toBe(201);
    const entry = await db.customerLedgerEntry.findFirstOrThrow({ where: { type: "ADJUSTMENT" } });
    expect(entry).toMatchObject({ userId: t.ownerA.id, note: "Old khata carried over" });
    expect(await db.auditLog.count({ where: { action: "customer.adjustment" } })).toBe(1);
  });

  it("lists overdue customers by the age of their oldest unpaid credit", async () => {
    const late = await db.customer.create({ data: { branchId: t.branchA1.id, name: "Late payer" } });
    const recent = await db.customer.create({ data: { branchId: t.branchA1.id, name: "Recent" } });
    await db.customerLedgerEntry.create({ data: { branchId: t.branchA1.id, customerId: late.id, userId: t.cashierA1.id, type: "CREDIT_SALE", amount: 500, createdAt: new Date(Date.now() - 50 * DAY) } });
    await db.customerLedgerEntry.create({ data: { branchId: t.branchA1.id, customerId: recent.id, userId: t.cashierA1.id, type: "CREDIT_SALE", amount: 200, createdAt: new Date(Date.now() - 3 * DAY) } });
    const overdue = await call(customers.GET, { path: `/api/v1/customers?branchId=${t.branchA1.id}&status=overdue&days=30`, token: owner });
    expect((overdue.body.customers as ReceivableSummary[]).map((customer) => [customer.name, customer.daysOutstanding, customer.buckets.days31to60])).toEqual([["Late payer", 50, 500]]);
  });

  it("flags a credit sale over the customer's limit without losing it", async () => {
    const customer = await db.customer.create({ data: { branchId: t.branchA1.id, name: "Ali", creditLimit: 150 } });
    const [result] = await sync([await saleOp({ customerId: customer.id, quantity: 2 })]);
    expect(result).toMatchObject({ status: "applied", flags: ["CREDIT_LIMIT_EXCEEDED"] });
  });

  it("allows no credit at a limit of 0 and any amount with no limit", async () => {
    const strict = await db.customer.create({ data: { branchId: t.branchA1.id, name: "No credit" } });
    const trusted = await db.customer.create({ data: { branchId: t.branchA1.id, name: "Trusted", creditLimit: null } });
    const [refused, allowed] = await sync([await saleOp({ customerId: strict.id }), await saleOp({ customerId: trusted.id, quantity: 9 })]);
    expect(refused).toMatchObject({ status: "applied", flags: ["CREDIT_LIMIT_EXCEEDED"] });
    expect(allowed.flags).toBeUndefined();
    const listed = await call(customers.GET, { path: `/api/v1/customers?branchId=${t.branchA1.id}`, token: owner });
    expect((listed.body.customers as ReceivableSummary[]).map((customer) => [customer.name, customer.creditLimit])).toEqual([["No credit", 0], ["Trusted", null]]);
    const cleared = await call(customers.PATCH, { method: "PATCH", token: owner, body: { customerId: strict.id, creditLimit: null } });
    expect(cleared.body.customer).toMatchObject({ creditLimit: null });
  });

  it("lets the owner edit a customer but not give two customers the same phone", async () => {
    await db.customer.create({ data: { branchId: t.branchA1.id, name: "Ali", phone: "0300" } });
    const other = await db.customer.create({ data: { branchId: t.branchA1.id, name: "Sara" } });
    expect((await call(customers.PATCH, { method: "PATCH", token: owner, body: { customerId: other.id, phone: "0300" } })).status).toBe(409);
    const updated = await call(customers.PATCH, { method: "PATCH", token: owner, body: { customerId: other.id, creditLimit: 2000 } });
    expect(updated.body.customer).toMatchObject({ creditLimit: 2000, phone: null });
  });
});

describe("suppliers and payables", () => {
  it("tracks what is owed to each supplier through purchases, payments, and adjustments", async () => {
    const created = await call(suppliers.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, name: "Muller & Phipps", phone: "042-111" } });
    const supplier = created.body.supplier as PayableSummary;
    await db.supplierLedgerEntry.create({ data: { branchId: t.branchA1.id, supplierId: supplier.id, userId: t.ownerA.id, type: "PURCHASE", amount: 10000, createdAt: new Date(Date.now() - 40 * DAY) } });
    expect((await call(supplierLedger.POST, { method: "POST", token: owner, params: { id: supplier.id }, body: { type: "PAYMENT", amount: 4000, method: "cheque" } })).body.error?.code).toBe("REFERENCE_REQUIRED");
    expect((await call(supplierLedger.POST, { method: "POST", token: owner, params: { id: supplier.id }, body: { type: "PAYMENT", amount: 4000, method: "cheque", reference: "CHQ-5512" } })).status).toBe(201);
    await call(supplierLedger.POST, { method: "POST", token: owner, params: { id: supplier.id }, body: { type: "ADJUSTMENT", amount: -500, reason: "Short-supplied items" } });

    const ledger = await call(supplierLedger.GET, { token: owner, params: { id: supplier.id } });
    expect(ledger.body.supplier).toMatchObject({ balance: 5500, daysOutstanding: 40 });
    expect((ledger.body.entries as LedgerLine[])[1]).toMatchObject({ type: "PAYMENT", amount: -4000, method: "cheque", reference: "CHQ-5512", balanceAfter: 6000 });
    const payables = await call(suppliers.GET, { path: `/api/v1/suppliers?branchId=${t.branchA1.id}&status=owing`, token: owner });
    expect((payables.body.suppliers as PayableSummary[]).map((item) => [item.name, item.balance])).toEqual([["Muller & Phipps", 5500]]);
  });

  it("keeps supplier names unique per branch and books keep another tenant out", async () => {
    await call(suppliers.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, name: "Getz" } });
    expect((await call(suppliers.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, name: "Getz" } })).status).toBe(409);
    const supplier = await db.supplier.findFirstOrThrow();
    const ownerB = await webSession(t.ownerB.id);
    expect((await call(supplierLedger.POST, { method: "POST", token: ownerB, params: { id: supplier.id }, body: { type: "PAYMENT", amount: 10, method: "cash" } })).status).toBe(403);
  });
});

describe("narcotics register", () => {
  const prescription = { patientName: "Ahmed Raza", patientPhone: "0301-1234567", doctorName: "Dr. Saima Khan", doctorRegNo: "PMDC-12345", prescriptionRef: "RX-889" };

  async function controlledProduct() {
    const master = await db.masterProduct.create({ data: { name: "Xanax 0.5mg", generic: "Alprazolam", unitsPerPack: 3, tabletsPerStrip: 10, officialRetailPrice: 330, isControlled: true, isPrescriptionOnly: true } });
    const product = await db.product.create({ data: { branchId: t.branchA1.id, masterProductId: master.id, name: master.name } });
    const batch = await stockBatch(product.id, { batchNo: "XN-1", quantity: 300, retailPrice: 330, expiryDate: new Date(Date.now() + 400 * DAY) });
    return { product, batch };
  }

  it("records each controlled sale with the patient and doctor, linked to the sale", async () => {
    const { product, batch } = await controlledProduct();
    const sale = await saleOp({ productId: product.id, batchId: batch.id, quantity: 2, unitPrice: 330, prescription });
    expect((await sync([sale]))[0]).toMatchObject({ status: "applied" });
    const register = await call(controlled.GET, { path: `/api/v1/controlled-drugs?branchId=${t.branchA1.id}`, token: owner });
    expect(register.body.entries as ControlledRegisterEntry[]).toMatchObject([{ entryType: "ENTRY", productName: "Xanax 0.5mg", batchNo: "XN-1", unit: "pack", quantity: 2, patientName: "Ahmed Raza", doctorName: "Dr. Saima Khan", doctorRegNo: "PMDC-12345", prescriptionRef: "RX-889", recordedBy: "cashier-a1" }]);
    expect((register.body.entries as ControlledRegisterEntry[])[0].receiptNo).toBe((sale.payload as { receiptNo: string }).receiptNo);
  });

  it("cannot be silently edited or deleted", async () => {
    const { product, batch } = await controlledProduct();
    await sync([await saleOp({ productId: product.id, batchId: batch.id, unitPrice: 330, prescription })]);
    const entry = await db.controlledDrugRecord.findFirstOrThrow();
    await expect(db.controlledDrugRecord.update({ where: { id: entry.id }, data: { patientName: "Someone else" } })).rejects.toThrow(/cannot be changed or deleted/);
    await expect(db.controlledDrugRecord.delete({ where: { id: entry.id } })).rejects.toThrow(/cannot be changed or deleted/);
    expect(await db.controlledDrugRecord.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ patientName: "Ahmed Raza" });
  });

  it("adds reversal entries for voids and returns instead of changing the original", async () => {
    const { product, batch } = await controlledProduct();
    const voided = await saleOp({ productId: product.id, batchId: batch.id, quantity: 1, unitPrice: 330, prescription });
    const returned = await saleOp({ productId: product.id, batchId: batch.id, quantity: 3, unitPrice: 330, prescription });
    const voidedId = (voided.payload as { saleId: string }).saleId;
    const returnedId = (returned.payload as { saleId: string }).saleId;
    await sync([
      voided,
      op("sale.void", { saleId: voidedId, reason: "Wrong patient" }),
      returned,
      op("sale.return", { returnId: nextId("ret"), saleId: returnedId, reason: "Doctor changed dose", refundMethod: "cash", lines: [{ saleLineId: `${returnedId}-line`, quantity: 2 }] })
    ]);
    const entries = await db.controlledDrugRecord.findMany({ orderBy: { createdAt: "asc" } });
    expect(entries.map((entry) => [entry.entryType, entry.quantity, entry.saleId])).toEqual(expect.arrayContaining([
      ["ENTRY", 1, voidedId], ["REVERSAL", -1, voidedId], ["ENTRY", 3, returnedId], ["REVERSAL", -2, returnedId]
    ]));
    const reversal = entries.find((entry) => entry.entryType === "REVERSAL" && entry.saleId === voidedId)!;
    expect(reversal.reversesId).toBe(entries.find((entry) => entry.entryType === "ENTRY" && entry.saleId === voidedId)!.id);
  });

  it("flags a controlled sale that arrives without a prescription", async () => {
    const { product, batch } = await controlledProduct();
    const [result] = await sync([await saleOp({ productId: product.id, batchId: batch.id, unitPrice: 330 })]);
    expect(result).toMatchObject({ status: "applied", flags: ["CONTROLLED_WITHOUT_PRESCRIPTION"] });
    expect(await db.auditLog.count({ where: { action: "controlled_drug.missing_prescription" } })).toBe(1);
  });

  it("can only be read by the owner, never written by hand", async () => {
    const cashier = await deviceSession(t.cashierA1.id, t.deviceA1.id);
    expect((await call(controlled.GET, { path: `/api/v1/controlled-drugs?branchId=${t.branchA1.id}`, token: cashier })).status).toBe(403);
    expect("POST" in controlled).toBe(false);
  });
});
