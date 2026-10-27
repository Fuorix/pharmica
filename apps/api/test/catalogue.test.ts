import { db } from "@pharmica/database/client";
import { importMasterProducts, readMasterCsv } from "@pharmica/database/master-import";
import { beforeEach, describe, expect, it } from "vitest";
import * as catalogue from "../app/api/v1/catalogue/route";
import * as masterPrices from "../app/api/v1/catalogue/master/[id]/prices/route";
import * as master from "../app/api/v1/catalogue/master/route";
import * as sales from "../app/api/v1/sales/route";
import { call, deviceSession, resetDatabase, seedTenants, webSession } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY);

let t: Awaited<ReturnType<typeof seedTenants>>;
let cashier: string;
let owner: string;
let admin: string;

beforeEach(async () => {
  await resetDatabase();
  t = await seedTenants();
  cashier = await deviceSession(t.cashierA1.id, t.deviceA1.id);
  owner = await webSession(t.ownerA.id);
  admin = await webSession(t.admin.id);
});

/** A 2x10 tablet product in branch A1 with the given batches (quantities in packs). */
async function stockedProduct(batches: Array<{ batchNo: string; packs: number; price: number; expiresInDays: number }>, overrides: { retailPriceOverride?: number } = {}) {
  const masterProduct = await db.masterProduct.create({ data: { name: "Brufen 400mg", brand: "Brufen", generic: "Ibuprofen", company: "Abbott", barcode: "2000000009999", unitsPerPack: 2, tabletsPerStrip: 10, officialRetailPrice: 330 } });
  const product = await db.product.create({ data: { branchId: t.branchA1.id, masterProductId: masterProduct.id, name: masterProduct.name, barcode: masterProduct.barcode, ...overrides } });
  for (const batch of batches) {
    await db.batch.create({ data: { productId: product.id, batchNo: batch.batchNo, quantity: batch.packs * 20, retailPrice: batch.price, costPrice: batch.price * 0.8, expiryDate: inDays(batch.expiresInDays) } });
  }
  return product;
}

function sell(lines: Array<{ productId: string; quantity: number; unit: "pack" | "strip" | "tablet"; unitPrice?: number }>) {
  return call(sales.POST, { method: "POST", token: cashier, body: { branchId: t.branchA1.id, paymentMethod: "cash", lines } });
}

describe("catalogue search", () => {
  beforeEach(async () => {
    await stockedProduct([{ batchNo: "N1", packs: 5, price: 330, expiresInDays: 300 }]);
    await db.masterProduct.create({ data: { name: "Ponstan 250mg", brand: "Ponstan", generic: "Mefenamic Acid", company: "Pfizer", barcode: "2000000008888" } });
  });

  it.each([["brand", "brufen"], ["generic (salt)", "ibuprofen"], ["company", "abbott"], ["barcode", "2000000009999"]])("finds stocked items by %s", async (_field, query) => {
    const response = await call(catalogue.GET, { path: `/api/v1/catalogue?branchId=${t.branchA1.id}&q=${encodeURIComponent(query)}`, token: cashier });
    expect(response.status).toBe(200);
    expect((response.body.products as Array<{ name: string }>).map((product) => product.name)).toContain("Brufen 400mg");
  });

  it("returns stock, selling price, and sellable units", async () => {
    const response = await call(catalogue.GET, { path: `/api/v1/catalogue?branchId=${t.branchA1.id}&q=brufen`, token: cashier });
    expect((response.body.products as unknown[])[0]).toMatchObject({ sellingPrice: 330, stockQuantity: 100, sellableUnits: ["pack", "strip", "tablet"], unitsPerPack: 2, tabletsPerStrip: 10 });
  });

  it("offers master-list medicines the branch does not stock yet", async () => {
    const response = await call(catalogue.GET, { path: `/api/v1/catalogue?branchId=${t.branchA1.id}&q=pfizer`, token: cashier });
    expect(response.body.products).toEqual([]);
    expect((response.body.masterMatches as Array<{ name: string }>).map((item) => item.name)).toEqual(["Ponstan 250mg"]);
  });
});

describe("batch pricing and earliest-expiry selling", () => {
  it("sells the earliest-expiring batch first, each at its own retail price", async () => {
    const product = await stockedProduct([
      { batchNo: "NEW", packs: 10, price: 330, expiresInDays: 500 },
      { batchNo: "OLD", packs: 2, price: 300, expiresInDays: 90 }
    ]);
    const response = await sell([{ productId: product.id, quantity: 3, unit: "pack" }]);
    expect(response.status).toBe(201);
    const sale = response.body.sale as { total: number; lines: Array<{ quantity: number; unitPrice: number; batchId: string }> };
    expect(sale.lines.map((line) => [line.quantity, line.unitPrice])).toEqual([[2, 300], [1, 330]]);
    expect(sale.total).toBe(930);

    const batches = await db.batch.findMany({ where: { productId: product.id }, orderBy: { batchNo: "asc" } });
    expect(batches.map((batch) => [batch.batchNo, batch.quantity])).toEqual([["NEW", 180], ["OLD", 0]]);
    const movements = await db.stockMovement.findMany({ where: { productId: product.id } });
    expect(movements.map((movement) => [movement.type, movement.quantity]).sort()).toEqual([["SALE", -20], ["SALE", -40]]);
    expect(new Set(movements.map((movement) => movement.referenceId))).toEqual(new Set([(response.body.sale as { id: string }).id]));
  });

  it("never sells expired stock", async () => {
    const product = await stockedProduct([
      { batchNo: "EXPIRED", packs: 10, price: 300, expiresInDays: -5 },
      { batchNo: "GOOD", packs: 1, price: 330, expiresInDays: 200 }
    ]);
    const response = await sell([{ productId: product.id, quantity: 2, unit: "pack" }]);
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("INSUFFICIENT_STOCK");
    expect(await db.batch.findFirst({ where: { batchNo: "EXPIRED" } })).toMatchObject({ quantity: 200 });
  });

  it("sells strips and tablets at their share of the pack price", async () => {
    const product = await stockedProduct([{ batchNo: "B", packs: 1, price: 300, expiresInDays: 200 }]);
    const response = await sell([{ productId: product.id, quantity: 1, unit: "strip" }, { productId: product.id, quantity: 3, unit: "tablet" }]);
    expect(response.status).toBe(201);
    expect((response.body.sale as { total: number }).total).toBe(150 + 45);
    expect((await db.batch.findFirstOrThrow({ where: { productId: product.id } })).quantity).toBe(20 - 13);
  });

  it("blocks a price above the batch's retail price but allows a lower one", async () => {
    const product = await stockedProduct([{ batchNo: "B", packs: 5, price: 330, expiresInDays: 200 }]);
    const above = await sell([{ productId: product.id, quantity: 1, unit: "pack", unitPrice: 340 }]);
    expect(above.status).toBe(400);
    expect(above.body.error?.code).toBe("ABOVE_RETAIL_PRICE");
    const below = await sell([{ productId: product.id, quantity: 1, unit: "pack", unitPrice: 320 }]);
    expect(below.status).toBe(201);
  });

  it("applies a shop override below the batch price", async () => {
    const product = await stockedProduct([{ batchNo: "B", packs: 5, price: 330, expiresInDays: 200 }], { retailPriceOverride: 310 });
    const response = await sell([{ productId: product.id, quantity: 1, unit: "pack" }]);
    expect((response.body.sale as { total: number }).total).toBe(310);
  });

  it("rejects units a product cannot be split into", async () => {
    const syrupMaster = await db.masterProduct.create({ data: { name: "Brufen Syrup", unitsPerPack: 1, tabletsPerStrip: 1 } });
    const syrup = await db.product.create({ data: { branchId: t.branchA1.id, masterProductId: syrupMaster.id, name: "Brufen Syrup" } });
    await db.batch.create({ data: { productId: syrup.id, batchNo: "S", quantity: 5, retailPrice: 145, expiryDate: inDays(300) } });
    const response = await sell([{ productId: syrup.id, quantity: 1, unit: "tablet" }]);
    expect(response.body.error?.code).toBe("INVALID_UNIT");
  });

  it("validates the request body", async () => {
    const response = await call(sales.POST, { method: "POST", token: cashier, body: { branchId: t.branchA1.id, paymentMethod: "cash", lines: [{ productId: t.productA1.id, quantity: 1.5, unit: "pack" }] } });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe("VALIDATION_FAILED");
  });

  it("is protected by database constraints against negative stock", async () => {
    await expect(db.batch.updateMany({ where: { productId: t.productA1.id }, data: { quantity: -1 } })).rejects.toThrow();
  });
});

describe("master price history", () => {
  let masterId: string;
  beforeEach(async () => {
    const created = await call(master.POST, { method: "POST", token: admin, body: { name: "Norvasc 5mg", company: "Pfizer", unitsPerPack: 2, tabletsPerStrip: 10, officialRetailPrice: 560, priceSource: "COMPANY_PRICE_LIST", priceReference: "Pfizer list Jan 2026" } });
    expect(created.status).toBe(201);
    masterId = (created.body.product as { id: string }).id;
  });

  const history = () => call(masterPrices.GET, { token: owner, params: { id: masterId } });
  const record = (body: object) => call(masterPrices.POST, { method: "POST", token: admin, params: { id: masterId }, body });

  it("keeps every price with its date and source instead of overwriting", async () => {
    expect((await record({ price: 600, source: "SRO", reference: "SRO 123(I)/2026" })).status).toBe(201);
    const response = await history();
    expect((response.body.history as Array<{ price: number; source: string }>).map((entry) => [entry.price, entry.source])).toEqual([[600, "SRO"], [560, "COMPANY_PRICE_LIST"]]);
    expect(response.body.current).toMatchObject({ price: 600, reference: "SRO 123(I)/2026" });
    expect(Number((await db.masterProduct.findUniqueOrThrow({ where: { id: masterId } })).officialRetailPrice)).toBe(600);
  });

  it("schedules a future price without changing today's price", async () => {
    await record({ price: 650, source: "SRO", effectiveFrom: inDays(30).toISOString() });
    const response = await history();
    expect(response.body.current).toMatchObject({ price: 560 });
    expect(response.body.scheduled).toMatchObject({ price: 650 });
    expect(Number((await db.masterProduct.findUniqueOrThrow({ where: { id: masterId } })).officialRetailPrice)).toBe(560);
  });

  it("records a back-dated correction without replacing a newer price", async () => {
    await record({ price: 540, source: "DISTRIBUTOR_INVOICE", effectiveFrom: inDays(-60).toISOString() });
    expect((await history()).body.current).toMatchObject({ price: 560 });
  });

  it("only lets Pharmica admins change master prices", async () => {
    expect((await call(masterPrices.POST, { method: "POST", token: owner, params: { id: masterId }, body: { price: 1, source: "MANUAL" } })).status).toBe(403);
  });

  it("rejects unknown sources and bad prices", async () => {
    expect((await record({ price: 600, source: "WHATSAPP" })).status).toBe(400);
    expect((await record({ price: -5, source: "SRO" })).status).toBe(400);
    expect((await record({ price: 1.005, source: "SRO" })).status).toBe(400);
  });
});

describe("branch catalogue management", () => {
  it("adds a master medicine to a branch once", async () => {
    const masterProduct = await db.masterProduct.create({ data: { name: "Ponstan 250mg", company: "Pfizer" } });
    const first = await call(catalogue.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, masterProductId: masterProduct.id } });
    const second = await call(catalogue.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, masterProductId: masterProduct.id } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(await db.product.count({ where: { masterProductId: masterProduct.id } })).toBe(1);
  });

  it("creates shop-specific items with a category and price, and rejects duplicate barcodes", async () => {
    const body = { branchId: t.branchA1.id, name: "Surgical Gloves (pair)", category: "surgical", barcode: "2100000000021", retailPrice: 60 };
    const created = await call(catalogue.POST, { method: "POST", token: owner, body });
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({ category: "surgical", isShopSpecific: true, retailPriceOverride: 60, sellableUnits: ["pack"], isPrescriptionOnly: false });
    expect((await call(catalogue.POST, { method: "POST", token: owner, body })).status).toBe(409);
  });

  it("lets the owner set rack location and a price override", async () => {
    const response = await call(catalogue.PATCH, { method: "PATCH", token: owner, body: { productId: t.productA1.id, rackLocation: "A-3", retailPriceOverride: 95 } });
    expect(response.body.product).toMatchObject({ rackLocation: "A-3", retailPriceOverride: 95, sellingPrice: 95 });
    expect(await db.auditLog.count({ where: { action: "catalogue.price_override_changed" } })).toBe(1);
  });

  it("corrects a medicine's packing for the branch, keeping the number of packs on the shelf", async () => {
    // Panadol on the medicine list is 10 x 10, and the branch holds 1000 tablets: 10 packs.
    const response = await call(catalogue.PATCH, { method: "PATCH", token: owner, body: { productId: t.productA1.id, packing: { stripsPerPack: 2, tabletsPerStrip: 10 } } });
    expect(response.status).toBe(200);
    expect(response.body.product).toMatchObject({ unitsPerPack: 2, tabletsPerStrip: 10, stockQuantity: 200, sellableUnits: ["pack", "strip", "tablet"] });
    const movement = await db.stockMovement.findFirstOrThrow({ where: { productId: t.productA1.id, type: "ADJUSTMENT" } });
    expect(movement).toMatchObject({ quantity: -800, reason: "Packing corrected from 10 x 10 to 2 x 10", userId: t.ownerA.id });
    expect(await db.auditLog.count({ where: { action: "catalogue.packing_changed" } })).toBe(1);
    // The medicine list itself is unchanged, and saving the same packing again changes nothing.
    expect(await db.masterProduct.findFirstOrThrow({ where: { name: "Panadol 500mg" } })).toMatchObject({ unitsPerPack: 10, tabletsPerStrip: 10 });
    await call(catalogue.PATCH, { method: "PATCH", token: owner, body: { productId: t.productA1.id, packing: { stripsPerPack: 2, tabletsPerStrip: 10 } } });
    expect(await db.stockMovement.count({ where: { productId: t.productA1.id, type: "ADJUSTMENT" } })).toBe(1);
  });

  it("refuses packing below one and leaves packing changes to owners", async () => {
    expect((await call(catalogue.PATCH, { method: "PATCH", token: owner, body: { productId: t.productA1.id, packing: { stripsPerPack: 0, tabletsPerStrip: 10 } } })).status).toBe(400);
    expect((await call(catalogue.PATCH, { method: "PATCH", token: cashier, body: { productId: t.productA1.id, packing: { stripsPerPack: 2, tabletsPerStrip: 10 } } })).status).toBe(403);
  });

  it("forbids changing another tenant's products", async () => {
    const ownerB = await webSession(t.ownerB.id);
    expect((await call(catalogue.PATCH, { method: "PATCH", token: ownerB, body: { productId: t.productA1.id, rackLocation: "X" } })).status).toBe(403);
  });
});

describe("master list import", () => {
  const csv = [
    "name,brand,generic,company,unitsPerPack,tabletsPerStrip,officialRetailPrice,isPrescriptionOnly,isControlled,barcode,drapRegistrationNo",
    "Risek 20mg,Risek,Omeprazole,Getz Pharma,1,14,350,no,no,2000000000301,",
    "\"Xanax 0.5mg\",Xanax,Alprazolam,Pfizer,3,10,330,no,yes,2000000000302,",
    ",Missing,Name,X,1,1,10,no,no,,",
    "Bad Pack,Bad,Bad,X,0,1,10,no,no,,"
  ].join("\n");

  it("imports valid rows, reports bad ones by line, and treats controlled drugs as prescription-only", async () => {
    const { rows, issues } = readMasterCsv(csv);
    expect(issues.map((issue) => issue.line)).toEqual([4, 5]);
    const result = await importMasterProducts(db, rows, { source: "DRAP_IMPORT" });
    expect(result).toMatchObject({ created: 2, updated: 0, priceChanges: 0 });
    expect(await db.masterProduct.findUniqueOrThrow({ where: { barcode: "2000000000302" } })).toMatchObject({ isControlled: true, isPrescriptionOnly: true });
    expect(await db.masterPriceHistory.count()).toBe(2);
  });

  it("accepts Excel CSV exports that start with a byte-order mark", () => {
    expect(readMasterCsv("\uFEFFname,company\nPanadol 500mg,GSK\n").rows).toMatchObject([{ name: "Panadol 500mg", company: "GSK" }]);
  });

  it("is safe to repeat and versions price changes", async () => {
    await importMasterProducts(db, readMasterCsv(csv).rows, { source: "DRAP_IMPORT" });
    expect(await importMasterProducts(db, readMasterCsv(csv).rows, { source: "DRAP_IMPORT" })).toMatchObject({ created: 0, unchanged: 2 });

    const repriced = csv.replace("Getz Pharma,1,14,350", "Getz Pharma,1,14,375");
    expect(await importMasterProducts(db, readMasterCsv(repriced).rows, { source: "SRO", reference: "SRO 9/2026" })).toMatchObject({ priceChanges: 1 });
    const prices = await db.masterPriceHistory.findMany({ where: { masterProduct: { barcode: "2000000000301" } }, orderBy: { createdAt: "asc" } });
    expect(prices.map((entry) => [Number(entry.price), entry.source])).toEqual([[350, "DRAP_IMPORT"], [375, "SRO"]]);
  });
});
