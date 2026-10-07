import type { DeviceDiagnostics, MasterListPage, MasterProductSummary, PosOperation, PosSnapshot, PosStaffMember, PosSyncResult } from "@pharmica/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryDb, type LocalDb } from "./db";
import { DeviceRevokedError, OfflineError, PosEngine, type Transport } from "./engine";
import { checkPin, createPinVerifier } from "./pin";

const cashier: PosStaffMember = { id: "u-cashier", name: "Sana", role: "cashier", maxDiscountPercent: 5 };
const owner: PosStaffMember = { id: "u-owner", name: "Owner", role: "owner", maxDiscountPercent: null };
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

function snapshot(quantities: { old: number; new: number } = { old: 40, new: 200 }): PosSnapshot {
  const product = { id: "p-brufen", branchId: "b1", masterProductId: "m1", name: "Brufen 400mg", brand: "Brufen", generic: "Ibuprofen", company: "Abbott", barcode: "2000000000013", category: "medicine" as const, unitsPerPack: 2, tabletsPerStrip: 10, sellableUnits: ["pack" as const, "strip" as const, "tablet" as const], officialRetailPrice: 330, retailPriceOverride: null, sellingPrice: 300, stockQuantity: 240, nearestExpiry: null, isPrescriptionOnly: false, isControlled: false, rackLocation: "A1", lowStockThreshold: 0, isShopSpecific: false };
  return {
    generatedAt: new Date().toISOString(),
    device: { id: "device-7k2q", name: "Counter 1", branchId: "b1", branchName: "Main" },
    organisationName: "Demo Pharmacy",
    staff: [cashier, owner],
    products: [product, { ...product, id: "p-arinac", name: "Arinac", barcode: "2000000000020" }, { ...product, id: "p-xanax", name: "Xanax 0.5mg", generic: "Alprazolam", barcode: "2000000000431", isControlled: true, isPrescriptionOnly: true }],
    batches: [
      { id: "old", productId: "p-brufen", batchNo: "OLD", expiryDate: future(60), quantity: quantities.old, retailPrice: 300 },
      { id: "new", productId: "p-brufen", batchNo: "NEW", expiryDate: future(500), quantity: quantities.new, retailPrice: 330 },
      { id: "arinac", productId: "p-arinac", batchNo: "A", expiryDate: future(300), quantity: 100, retailPrice: 310 },
      { id: "xanax", productId: "p-xanax", batchNo: "X", expiryDate: future(300), quantity: 60, retailPrice: 330 }
    ],
    customers: [{ id: "c-ali", name: "Ali", phone: "0300", creditLimit: 1000, balance: 400, daysOutstanding: 12 }],
    suppliers: [{ id: "s-mp", name: "Muller & Phipps" }]
  };
}

/** A fake server: records uploads, and can be switched offline or told to reject an operation type. */
class FakeServer implements Transport {
  received: PosOperation[] = [];
  offline = false;
  revoked = false;
  reject: string | null = null;
  /** Uploads work but downloading the snapshot fails, as when the line drops mid-sync. */
  snapshotDown = false;
  current = snapshot();
  async snapshot() {
    if (this.offline || this.snapshotDown) throw new OfflineError("offline");
    if (this.revoked) throw new DeviceRevokedError("revoked");
    return this.current;
  }
  master: MasterProductSummary[] = [{ id: "m-risek", name: "Risek 20mg", brand: "Risek", generic: "Omeprazole", company: "Getz Pharma", dosageForm: "Capsule", strength: "20mg", barcode: "2000000000099", unitsPerPack: 1, tabletsPerStrip: 14, officialRetailPrice: 350, isPrescriptionOnly: false, isControlled: false }];
  reports: DeviceDiagnostics[] = [];
  masterRequests: Array<string | null> = [];
  /** Operation types the server answers "retry" for, as if its database were struggling. */
  busyFor: string | null = null;
  /** Drop the connection after this many master-list pages. */
  masterPagesBeforeDrop = Infinity;
  /** Serves the master list one product per page; the cursor is the index of the next product. */
  async masterList(since: string | null): Promise<MasterListPage> {
    if (this.offline || this.masterPagesBeforeDrop-- <= 0) throw new OfflineError("offline");
    this.masterRequests.push(since);
    const start = since ? Number(since) : 0;
    const products = this.master.slice(start, start + 1);
    return { products, nextCursor: String(start + products.length), hasMore: start + 1 < this.master.length };
  }
  async reportDiagnostics(report: DeviceDiagnostics) {
    this.reports.push(report);
  }
  async searchMaster(query: string) {
    if (this.offline) throw new OfflineError("offline");
    return this.master.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  }
  async push(operations: PosOperation[]): Promise<PosSyncResult[]> {
    if (this.offline) throw new OfflineError("offline");
    if (this.revoked) throw new DeviceRevokedError("revoked");
    return operations.map((operation) => {
      if (this.reject === operation.type) return { id: operation.id, status: "failed", error: { code: "REJECTED", message: "no" } };
      if (this.busyFor === operation.type) return { id: operation.id, status: "retry", error: { code: "SERVER_BUSY", message: "busy" } };
      const duplicate = this.received.some((seen) => seen.id === operation.id);
      if (!duplicate) this.received.push(operation);
      return { id: operation.id, status: duplicate ? "duplicate" : "applied" };
    });
  }
}

let db: LocalDb;
let server: FakeServer;
let engine: PosEngine;

beforeEach(async () => {
  db = memoryDb();
  server = new FakeServer();
  engine = await PosEngine.open(db, server, "device-7k2q");
  await engine.syncNow();
  await engine.openShift(cashier, 5000);
  await engine.syncNow();
  server.offline = true;
});

const stockOf = (batchId: string) => engine.getState().stock!.batches.find((batch) => batch.id === batchId)!.quantity;
const sell = (items: Array<{ productId?: string; unit?: "pack" | "strip" | "tablet"; quantity: number; discount?: number }>, extra: Partial<Parameters<PosEngine["completeSale"]>[0]> = {}) =>
  engine.completeSale({ user: cashier, billDiscount: 0, paymentMethod: "cash", items: items.map((item, index) => ({ key: String(index), productId: item.productId ?? "p-brufen", unit: item.unit ?? "pack", quantity: item.quantity, discount: item.discount ?? 0 })), ...extra });

describe("billing offline", () => {
  it("completes a sale with no network: earliest expiry first, each batch at its own price", async () => {
    const sale = await sell([{ quantity: 3 }]);
    expect(sale.receiptNo).toBe("7K2Q-000001");
    expect(sale.lines.map((line) => [line.batchNo, line.quantity, line.unitPrice])).toEqual([["OLD", 2, 300], ["NEW", 1, 330]]);
    expect(sale.total).toBe(930);
    expect(stockOf("old")).toBe(0);
    expect(stockOf("new")).toBe(180);
    expect(engine.getState().sync.pending).toBe(1);
  });

  it("keeps completed bills and queued uploads across a restart", async () => {
    await sell([{ quantity: 1 }]);
    const reopened = await PosEngine.open(db, server, "device-7k2q");
    expect(reopened.getState().sales).toHaveLength(1);
    expect(reopened.getState().outbox).toHaveLength(1);
    expect(reopened.getState().stock!.batches.find((batch) => batch.id === "old")!.quantity).toBe(20);
    expect((await sell([{ quantity: 1 }])).receiptNo).toBe("7K2Q-000002");
  });

  it("refuses invalid quantities, too little stock, and discounts above the cashier's limit", async () => {
    await expect(sell([{ quantity: 0 }])).rejects.toThrow("whole number above zero");
    await expect(sell([{ quantity: 13 }])).rejects.toThrow("only 12 packs in stock");
    await expect(sell([{ quantity: 1, discount: 30 }])).rejects.toThrow("discount limit is 5%");
    await expect(sell([{ quantity: 1, discount: 15 }])).resolves.toMatchObject({ total: 285 });
    await expect(engine.completeSale({ user: owner, billDiscount: 100, paymentMethod: "cash", items: [{ key: "a", productId: "p-arinac", unit: "pack", quantity: 1, discount: 0 }] })).resolves.toMatchObject({ total: 210 });
    expect(engine.getState().sales).toHaveLength(2);
  });

  it("enforces the customer's credit limit using unsynced credit sales too", async () => {
    await sell([{ quantity: 2 }], { paymentMethod: "credit", customerId: "c-ali" });
    expect(engine.getState().stock!.customers[0].balance).toBe(1000);
    await expect(sell([{ productId: "p-arinac", quantity: 1 }], { paymentMethod: "credit", customerId: "c-ali" })).rejects.toThrow("over their limit");
  });

  it("needs an open shift", async () => {
    server.offline = false;
    await engine.closeShift(cashier, 5000);
    await expect(sell([{ quantity: 1 }])).rejects.toThrow("Open a shift");
  });
});

describe("voids, returns, and the shift report", () => {
  it("voids a sale and puts its stock back", async () => {
    const sale = await sell([{ quantity: 3 }]);
    await engine.voidSale(cashier, sale.id, "Customer changed mind");
    expect(stockOf("old")).toBe(40);
    expect(stockOf("new")).toBe(200);
    await expect(engine.voidSale(cashier, sale.id, "again")).rejects.toThrow("Only a completed sale");
  });

  it("returns part of a sale to the right batch with a pro-rata refund", async () => {
    const sale = await sell([{ quantity: 2, unit: "strip" }], { billDiscount: 15 });
    const { saleReturn } = await engine.returnItems(cashier, sale.id, [{ saleLineId: sale.lines[0].lineId, quantity: 1 }], "Not needed", "cash");
    // 300 of strips with a 15 bill discount: each rupee refunds 0.95, so one 150 strip refunds 142.50.
    expect(saleReturn.amount).toBe(142.5);
    expect(stockOf("old")).toBe(40 - 20 + 10);
    await expect(engine.returnItems(cashier, sale.id, [{ saleLineId: sale.lines[0].lineId, quantity: 2 }], "x", "cash")).rejects.toThrow("Only 1 of that item");
  });

  it("closes the shift with expected cash after sales, voids, and refunds", async () => {
    const kept = await sell([{ quantity: 1 }]);
    const voided = await sell([{ productId: "p-arinac", quantity: 1 }]);
    await engine.voidSale(cashier, voided.id, "Mistake");
    await sell([{ productId: "p-arinac", quantity: 1 }], { paymentMethod: "card" });
    await engine.returnItems(cashier, kept.id, [{ saleLineId: kept.lines[0].lineId, quantity: 1 }], "Wrong strength", "cash");
    const report = engine.shiftReport(5000)!;
    expect(report).toMatchObject({ salesCount: 2, voidCount: 1, returnCount: 1, expectedCash: 5000 + 300 - 300, variance: 0 });
    expect(report.byMethod).toEqual({ cash: 300, card: 310, credit: 0 });
  });
});

describe("syncing", () => {
  it("uploads queued work in order once the network is back, then refreshes stock", async () => {
    await sell([{ quantity: 1 }]);
    await engine.createCustomer(cashier, { name: "Bilal", phone: "0311" });
    server.offline = false;
    server.current = snapshot({ old: 20, new: 200 });
    await engine.syncNow();
    expect(server.received.map((operation) => operation.type)).toEqual(["shift.open", "sale", "customer.create"]);
    expect(engine.getState().outbox).toEqual([]);
    expect(stockOf("old")).toBe(20);
  });

  it("does not lose queued work when the upload fails, and keeps rejected operations visible", async () => {
    await sell([{ quantity: 1 }]);
    await engine.syncNow();
    expect(engine.getState().outbox).toHaveLength(1);
    server.offline = false;
    server.reject = "sale";
    await engine.syncNow();
    expect(engine.getState().sync).toMatchObject({ pending: 0, failed: 1 });
    expect(stockOf("old")).toBe(20);
    server.reject = null;
    await engine.retryFailed();
    expect(engine.getState().sync).toMatchObject({ pending: 0, failed: 0 });
  });

  it("notices when the owner deactivates the counter", async () => {
    server.offline = false;
    server.revoked = true;
    await engine.syncNow();
    expect(engine.getState().deviceRevoked).toBe(true);
  });
});

describe("receiving and stock control offline", () => {
  const line = (overrides: object = {}) => ({ productId: "p-brufen", batchNo: "NEW-2", expiryDate: future(400).slice(0, 10), quantity: 2, bonusQuantity: 1, costPrice: 250, discount: 0, retailPrice: 330, ...overrides });

  it("receives a new batch that can be sold at once, with totals and the real cost per pack", async () => {
    const purchase = await engine.receivePurchase(cashier, { supplierName: "Muller & Phipps", invoiceNumber: "MP-7", invoiceDiscount: 0, lines: [line({ discount: 50 })] });
    expect(purchase.totals).toMatchObject({ subtotal: 500, lineDiscount: 50, total: 450, bonusPacks: 1 });
    expect(purchase.lines[0].effectiveCost).toBe(150);
    const received = engine.getState().stock!.batches.find((batch) => batch.batchNo === "NEW-2")!;
    expect(received.quantity).toBe(60);
    const operation = engine.getState().outbox.at(-1)!.operation;
    expect(operation).toMatchObject({ type: "purchase.receive", payload: { supplier: { id: "s-mp" }, lines: [{ batchId: received.id }] } });
  });

  it("adds to a batch already on the shelf and warns about a different price", async () => {
    const purchase = await engine.receivePurchase(cashier, { supplierName: "New Distributor", invoiceDiscount: 0, lines: [line({ batchNo: "NEW", quantity: 1, bonusQuantity: 0, retailPrice: 340 })] });
    expect(stockOf("new")).toBe(220);
    expect(purchase.warnings).toEqual([expect.stringContaining("already priced PKR 330.00")]);
  });

  it("starts stocking a master-list medicine and sells it before syncing", async () => {
    server.offline = false;
    const [risek] = await engine.searchMaster("risek");
    server.offline = true;
    const purchase = await engine.receivePurchase(cashier, { supplierName: "Getz", invoiceDiscount: 0, lines: [{ master: risek, batchNo: "RS-1", expiryDate: future(300).slice(0, 10), quantity: 3, bonusQuantity: 0, costPrice: 300, discount: 0, retailPrice: 360 }] });
    expect(purchase.warnings).toEqual([expect.stringContaining("differs from the master price PKR 350.00")]);
    const product = engine.getState().stock!.catalogue.find((item) => item.masterProductId === "m-risek")!;
    expect(product).toMatchObject({ sellingPrice: 360, stockQuantity: 42, sellableUnits: ["pack", "tablet"] });
    await expect(sell([{ productId: product.id, unit: "pack", quantity: 1 }])).resolves.toMatchObject({ total: 360 });
    // Loose tablets are priced per tablet (360 / 14 = 25.71), so 14 loose tablets come to 359.94.
    await expect(sell([{ productId: product.id, unit: "tablet", quantity: 14 }])).resolves.toMatchObject({ total: 359.94 });
  });

  it("refuses expired stock and empty invoices", async () => {
    await expect(engine.receivePurchase(cashier, { supplierName: "X", invoiceDiscount: 0, lines: [line({ expiryDate: "2020-01-31" })] })).rejects.toThrow("already expired");
    await expect(engine.receivePurchase(cashier, { supplierName: "X", invoiceDiscount: 0, lines: [] })).rejects.toThrow("at least one item");
  });

  it("writes off stock with a reason and never below zero", async () => {
    await expect(engine.adjustStock(cashier, { batchId: "old", type: "DAMAGE", quantity: -5, reason: "" })).rejects.toThrow("reason");
    await expect(engine.adjustStock(cashier, { batchId: "old", type: "DAMAGE", quantity: -50, reason: "Wet" })).rejects.toThrow("Only 40 units");
    await engine.adjustStock(cashier, { batchId: "old", type: "DAMAGE", quantity: -5, reason: "Wet" });
    expect(stockOf("old")).toBe(35);
  });

  it("applies a physical count as the difference from what the counter showed", async () => {
    expect(await engine.countStock(cashier, [{ batchId: "old", counted: 38 }, { batchId: "new", counted: 200 }], "Monthly count")).toBe(1);
    expect(stockOf("old")).toBe(38);
    expect(engine.getState().outbox.at(-1)!.operation).toMatchObject({ type: "stock.count", payload: { lines: [{ batchId: "old", expected: 40, counted: 38 }] } });
  });

  it("sets rack location and the low-stock alert", async () => {
    await engine.updateProduct(cashier, "p-brufen", { rackLocation: "C-4", lowStockThreshold: 20 });
    expect(engine.getState().stock!.catalogue.find((item) => item.id === "p-brufen")).toMatchObject({ rackLocation: "C-4", lowStockThreshold: 20 });
  });

  it("keeps received stock when the upload succeeds but the line drops before the new snapshot", async () => {
    await engine.receivePurchase(cashier, { supplierName: "Muller & Phipps", invoiceDiscount: 0, lines: [line()] });
    server.offline = false;
    server.snapshotDown = true;
    await engine.syncNow();
    expect(engine.getState().sync.pending).toBe(0);
    expect(engine.getState().stock!.batches.find((batch) => batch.batchNo === "NEW-2")?.quantity).toBe(60);

    // Once a snapshot that includes the purchase arrives, the confirmed entry is dropped.
    const received = server.received.find((operation) => operation.type === "purchase.receive")!;
    const batch = (received.payload as { lines: Array<{ batchId: string }> }).lines[0];
    server.snapshotDown = false;
    server.current = { ...server.current, batches: [...server.current.batches, { id: batch.batchId, productId: "p-brufen", batchNo: "NEW-2", expiryDate: future(400), quantity: 60, retailPrice: 330 }] };
    await engine.syncNow();
    expect(engine.getState().outbox).toEqual([]);
    expect(engine.getState().stock!.batches.find((entry) => entry.batchNo === "NEW-2")?.quantity).toBe(60);
  });

  it("searches the master list stored on the counter, even offline", async () => {
    expect(server.offline).toBe(true);
    expect((await engine.searchMaster("omeprazole")).map((product) => product.name)).toEqual(["Risek 20mg"]);
  });

  it("asks the server before the first master-list download, and needs the internet for that", async () => {
    const fresh = await PosEngine.open(memoryDb(), server, "device-new");
    await expect(fresh.searchMaster("risek")).rejects.toThrow(OfflineError);
  });
});

describe("credit repayments and controlled drugs", () => {
  it("takes a repayment offline, lowers what the customer owes, and counts the cash in the shift", async () => {
    const payment = await engine.receivePayment(cashier, { customerId: "c-ali", amount: 150, method: "cash" });
    expect(payment).toMatchObject({ amount: 150, balanceAfter: 250 });
    expect(engine.getState().stock!.customers[0].balance).toBe(250);
    expect(engine.getState().outbox.at(-1)!.operation).toMatchObject({ type: "customer.payment", payload: { customerId: "c-ali", amount: 150, method: "cash" } });
    expect(engine.shiftReport(5150)).toMatchObject({ expectedCash: 5150, variance: 0, collections: { cash: 150, card: 0, credit: 0 } });
    await expect(engine.receivePayment(cashier, { customerId: "c-ali", amount: 0, method: "cash" })).rejects.toThrow("amount");
  });

  it("refuses to sell a controlled drug without the patient and doctor, and records them when given", async () => {
    const items = [{ key: "x", productId: "p-xanax", unit: "pack" as const, quantity: 1, discount: 0 }];
    expect(engine.needsPrescription(items)).toBe(true);
    await expect(engine.completeSale({ user: cashier, items, billDiscount: 0, paymentMethod: "cash" })).rejects.toThrow("narcotics register");
    const prescription = { patientName: "Ahmed Raza", doctorName: "Dr. Saima Khan", doctorRegNo: "PMDC-12345" };
    const sale = await engine.completeSale({ user: cashier, items, billDiscount: 0, paymentMethod: "cash", prescription });
    expect(sale.prescription).toEqual(prescription);
    expect(engine.getState().outbox.at(-1)!.operation).toMatchObject({ type: "sale", payload: { prescription } });
  });

  it("does not attach a prescription to bills without controlled drugs", async () => {
    const sale = await sell([{ quantity: 1 }], { prescription: { patientName: "X", doctorName: "Y" } });
    expect(sale.prescription).toBeUndefined();
  });
});

describe("credit limits", () => {
  it("gives a new customer no credit unless the owner sets a limit or chooses no limit", async () => {
    const plain = await engine.createCustomer(cashier, { name: "Walk-in" });
    expect(plain.creditLimit).toBe(0);
    await expect(sell([{ quantity: 1 }], { paymentMethod: "credit", customerId: plain.id })).rejects.toThrow("not allowed credit");
    const trusted = await engine.createCustomer(cashier, { name: "Regular", creditLimit: null });
    await expect(sell([{ quantity: 1 }], { paymentMethod: "credit", customerId: trusted.id })).resolves.toMatchObject({ paymentMethod: "credit" });
  });
});

describe("sync recovery", () => {
  it("keeps an operation queued and backs off when the server has a problem, then sets it aside after repeated failures", async () => {
    await sell([{ quantity: 1 }]);
    server.offline = false;
    server.busyFor = "sale";
    const failuresBefore = engine.getState().sync.consecutiveFailures;
    await engine.syncNow();
    expect(engine.getState().sync).toMatchObject({ pending: 1, failed: 0 });
    expect(engine.getState().sync.consecutiveFailures).toBeGreaterThan(failuresBefore);
    expect(engine.getState().outbox[0]).toMatchObject({ status: "pending", attempts: 1 });
    for (let attempt = 2; attempt <= 8; attempt++) await engine.syncNow();
    expect(engine.getState().sync).toMatchObject({ pending: 0, failed: 1 });
    expect(engine.getState().outbox[0].error?.code).toBe("SERVER_KEPT_FAILING");
    // Billing carries on throughout.
    await expect(sell([{ quantity: 1 }])).resolves.toMatchObject({ total: 300 });
  });

  it("resumes the master-list download where a dropped connection left it", async () => {
    server.master = [...server.master, { ...server.master[0], id: "m-2", name: "Second" }, { ...server.master[0], id: "m-3", name: "Third" }];
    const db2 = memoryDb();
    const counter = await PosEngine.open(db2, server, "device-2");
    server.offline = false;
    server.masterPagesBeforeDrop = 1;
    await counter.syncNow();
    expect(counter.getState().sync.masterProducts).toBe(1);
    server.masterRequests = [];
    server.masterPagesBeforeDrop = Infinity;
    await counter.syncNow();
    expect(server.masterRequests).toEqual(["1", "2"]);
    expect(counter.getState().sync.masterProducts).toBe(3);
  });

  it("reports its health after each sync, and exports diagnostics without patient details", async () => {
    await engine.completeSale({ user: cashier, items: [{ key: "x", productId: "p-xanax", unit: "pack", quantity: 1, discount: 0 }], billDiscount: 0, paymentMethod: "cash", prescription: { patientName: "Ahmed Raza", doctorName: "Dr. Saima" } });
    const exported = JSON.stringify(engine.exportDiagnostics());
    expect(exported).not.toContain("Ahmed Raza");
    expect(exported).toContain("\"type\":\"sale\"");
    server.offline = false;
    await engine.syncNow();
    expect(server.reports.at(-1)).toMatchObject({ pending: 0, failed: 0, consecutiveFailures: 0, masterProducts: 1, localSales: 1 });
  });
});

describe("offline PIN check", () => {
  it("accepts the right PIN and locks after five wrong ones", async () => {
    let verifier = await createPinVerifier("u1", "4321");
    expect((await checkPin(verifier, "4321")).ok).toBe(true);
    for (let attempt = 0; attempt < 5; attempt++) verifier = (await checkPin(verifier, "0000")).verifier;
    const locked = await checkPin(verifier, "4321");
    expect(locked).toMatchObject({ ok: false, locked: true });
  });
});
