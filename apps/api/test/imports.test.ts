import type { ImportJobDetail, ImportRowItem } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { ageLedger, ledgerBalance } from "@pharmica/domain";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import * as problemsRoute from "../app/api/v1/imports/[id]/problems/route";
import * as importRoute from "../app/api/v1/imports/[id]/route";
import * as importsRoute from "../app/api/v1/imports/route";
import * as templateRoute from "../app/api/v1/imports/templates/[id]/route";
import { call, resetDatabase, seedTenants, webSession } from "./helpers";

let t: Awaited<ReturnType<typeof seedTenants>>;
let owner: string;
let augmentin625: { id: string };
const DAY = 86_400_000;

beforeEach(async () => {
  await resetDatabase();
  t = await seedTenants();
  owner = await webSession(t.ownerA.id);
  await db.masterProduct.update({ where: { id: (await db.product.findUniqueOrThrow({ where: { id: t.productA1.id } })).masterProductId! }, data: { barcode: "8964000111222" } });
  augmentin625 = await db.masterProduct.create({ data: { name: "Augmentin 625mg", company: "GSK", unitsPerPack: 1, tabletsPerStrip: 6, officialRetailPrice: 450 } });
  // A second Augmentin, so "Augmentin" alone is ambiguous.
  await db.masterProduct.create({ data: { name: "Augmentin 1g", company: "GSK", unitsPerPack: 1, tabletsPerStrip: 6, officialRetailPrice: 640 } });
});

const csv = (lines: string[][]) => Buffer.from(lines.map((line) => line.map((cell) => /[",]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join(",")).join("\r\n"));
const upload = (content: Buffer, fileName: string, kind = "STOCK", branchId = t.branchA2.id, token = owner) =>
  call(importsRoute.POST, { method: "POST", token, body: { branchId, kind, fileName, content: content.toString("base64") } });
const detail = async (id: string, filter = "all", token = owner) => (await call(importRoute.GET, { token, path: `/x?filter=${filter}`, params: { id } })).body as unknown as ImportJobDetail;
const byLine = (rows: ImportRowItem[], line: number) => rows.find((row) => row.line === line)!;

const STOCK_FILE = csv([
  ["Item Name", "Barcode", "Packing", "Batch No", "Expiry", "Qty", "Loose", "TP", "MRP"],
  ["PANADOL TAB 500 MG", "", "10x10", "P1", "03/2028", "5", "3", "80", ""],
  ["Augmentin", "", "1x6", "A1", "Dec-27", "4", "", "400", ""],
  ["Surbex Z", "", "1x30", "S1", "31/01/2028", "2", "", "380", "450"],
  ["Old Cough Syrup", "", "", "C1", "01/2020", "1", "", "", "90"],
  ["No Price Cream", "", "", "N1", "2028-05-31", "2", "", "", ""],
  ["Surbex Z", "", "1x30", "S2", "30/06/2028", "1", "", "380", "450"],
  ["panadol 500mg", "8964000111222", "", "P1", "03/2028", "9", "", "80", ""]
]);

describe("stock import", () => {
  it("matches names, holds unclear rows for a person, and commits everything or nothing", async () => {
    const created = await upload(STOCK_FILE, "abuzar-stock.csv");
    expect(created.status).toBe(201);
    const job = (created.body as unknown as ImportJobDetail).job;
    expect(job).toMatchObject({ status: "REVIEW", rowCount: 7, counts: { ready: 4, needsReview: 1, invalid: 2 } });
    const rows = (await detail(job.id)).rows;
    expect(byLine(rows, 2)).toMatchObject({ status: "READY", action: "MASTER", masterName: "Panadol 500mg" });
    expect(byLine(rows, 3)).toMatchObject({ status: "NEEDS_REVIEW", action: null });
    expect(byLine(rows, 3).candidates.map((candidate) => candidate.name)).toEqual(expect.arrayContaining(["Augmentin 625mg", "Augmentin 1g"]));
    expect(byLine(rows, 4)).toMatchObject({ status: "READY", action: "NEW" });
    expect(byLine(rows, 5)).toMatchObject({ status: "INVALID", problems: [expect.stringContaining("Already expired")] });
    expect(byLine(rows, 6)).toMatchObject({ status: "INVALID", problems: [expect.stringContaining("Retail price is needed")] });
    expect(byLine(rows, 8)).toMatchObject({ status: "READY", action: "MASTER" });

    // Nothing reaches the shop until the unclear row is decided.
    const early = await call(importRoute.POST, { method: "POST", token: owner, params: { id: job.id }, body: { action: "commit" } });
    expect(early.body.error).toMatchObject({ code: "IMPORT_NOT_COMMITTED", message: "1 row needs a decision first" });
    expect(await db.product.count({ where: { branchId: t.branchA2.id } })).toBe(0);

    const decided = await call(importRoute.PATCH, { method: "PATCH", token: owner, params: { id: job.id }, body: { decisions: [{ rowId: byLine(rows, 3).id, action: "MASTER", masterProductId: augmentin625.id }] } });
    expect(decided.body).toMatchObject({ applied: 1, errors: [] });
    const committed = await call(importRoute.POST, { method: "POST", token: owner, params: { id: job.id }, body: { action: "commit" } });
    expect(committed.status).toBe(200);
    expect((committed.body as unknown as ImportJobDetail).job).toMatchObject({ status: "COMMITTED", summary: { itemsCreated: 1, itemsLinked: 2, batches: 4, skipped: 1 } });

    const products = await db.product.findMany({ where: { branchId: t.branchA2.id }, include: { batches: true }, orderBy: { name: "asc" } });
    expect(products.map((product) => [product.name, product.isShopSpecific, product.batches.map((batch) => [batch.batchNo, batch.quantity, Number(batch.retailPrice)])])).toEqual([
      ["Augmentin 625mg", false, [["A1", 24, 450]]],
      ["Panadol 500mg", false, [["P1", 503, 100]]],
      ["Surbex Z", true, [["S1", 60, 450], ["S2", 30, 450]]]
    ]);
    // Opening stock entered through the ledger, so stock equals its movements.
    for (const batch of products.flatMap((product) => product.batches)) {
      const moved = await db.stockMovement.aggregate({ where: { batchId: batch.id }, _sum: { quantity: true } });
      expect(moved._sum.quantity).toBe(batch.quantity);
    }
    expect(byLine((await detail(job.id)).rows, 8)).toMatchObject({ status: "SKIPPED", problems: [expect.stringContaining("already in stock")] });
    expect(await db.auditLog.count({ where: { entityId: job.id, action: "import.committed" } })).toBe(1);

    // The same file again would double the stock: refused.
    const again = await upload(STOCK_FILE, "abuzar-stock-copy.csv");
    expect(again.body.error).toMatchObject({ code: "IMPORT_ALREADY_DONE" });
  });

  it("changes nothing at all when a commit fails part-way, and can then be committed", async () => {
    const job = ((await upload(STOCK_FILE, "stock.csv")).body as unknown as ImportJobDetail).job;
    const rows = (await detail(job.id)).rows;
    await call(importRoute.PATCH, { method: "PATCH", token: owner, params: { id: job.id }, body: { decisions: [{ rowId: byLine(rows, 3).id, action: "SKIP" }] } });
    // Break the last ready row behind the import back, so the commit fails after earlier rows were written.
    const last = byLine(rows, 7);
    await db.importRow.update({ where: { id: last.id }, data: { data: { ...last.data, expiry: null } } });

    const failed = await call(importRoute.POST, { method: "POST", token: owner, params: { id: job.id }, body: { action: "commit" } });
    expect(failed.status).toBe(500);
    expect(await db.product.count({ where: { branchId: t.branchA2.id } })).toBe(0);
    expect(await db.stockMovement.count({ where: { branchId: t.branchA2.id } })).toBe(0);
    expect((await detail(job.id)).job).toMatchObject({ status: "REVIEW", lastError: expect.stringContaining("nothing was changed") });

    await db.importRow.update({ where: { id: last.id }, data: { data: last.data! as object } });
    expect((await call(importRoute.POST, { method: "POST", token: owner, params: { id: job.id }, body: { action: "commit" } })).status).toBe(200);
    expect(await db.product.count({ where: { branchId: t.branchA2.id } })).toBe(2);
  });

  it("commits once when two people press commit together", async () => {
    const job = ((await upload(csv([["Name", "Expiry", "Qty", "Retail price"], ["Surbex Z", "2028-01-31", "3", "450"]]), "one.csv")).body as unknown as ImportJobDetail).job;
    const results = await Promise.all([1, 2].map(() => call(importRoute.POST, { method: "POST", token: owner, params: { id: job.id }, body: { action: "commit" } })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await db.batch.count({ where: { product: { branchId: t.branchA2.id } } })).toBe(1);
  });

  it("lets a person match the columns of an unfamiliar file", async () => {
    const file = csv([["Dawa", "Miqdar", "Khatam", "Qeemat"], ["Brufen 400", "2", "2028-01-31", "120"]]);
    const created = (await upload(file, "urdu-headings.csv")).body as unknown as ImportJobDetail;
    expect(created.job.status).toBe("MAPPING");
    expect((await call(importRoute.PATCH, { method: "PATCH", token: owner, params: { id: created.job.id }, body: { columnMap: { packs: "Miqdar" } } })).body.error?.message).toBe("Choose the column for Item name");
    const mapped = await call(importRoute.PATCH, { method: "PATCH", token: owner, params: { id: created.job.id }, body: { columnMap: { name: "Dawa", packs: "Miqdar", expiry: "Khatam", retailPrice: "Qeemat" } } });
    expect((mapped.body as unknown as ImportJobDetail).job).toMatchObject({ status: "REVIEW", counts: { ready: 1 } });
  });

  it("gives back the rows to fix, with the reasons, as CSV", async () => {
    const job = ((await upload(STOCK_FILE, "stock.csv")).body as unknown as ImportJobDetail).job;
    const response = await problemsRoute.GET(new Request("http://localhost/x", { headers: { authorization: `Bearer ${owner}` } }), { params: Promise.resolve({ id: job.id }) });
    const lines = (await response.text()).replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Line,Status,Problems,Item Name,Barcode,Packing,Batch No,Expiry,Qty,Loose,TP,MRP");
    expect(lines.slice(1).map((line) => line.split(",")[0])).toEqual(["3", "5", "6"]);
  });
});

describe("customer and supplier imports", () => {
  async function workbook(rows: Array<Array<string | number | Date>>) {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Data");
    rows.forEach((row) => sheet.addRow(row));
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  it("brings in customers with what they owe, dated for ageing, and skips ones already there", async () => {
    await db.customer.create({ data: { branchId: t.branchA2.id, name: "Existing Khan", phone: "03001112222" } });
    const file = await workbook([
      ["Customer Name", "Mobile", "Owes the shop (PKR)", "Owed since", "Credit limit (PKR)"],
      ["Ali Raza", "0300-1234567", 2350, new Date(Date.now() - 50 * DAY), ""],
      ["Sana Bibi", "0321-7654321", "(500)", "", 0],
      ["Existing Khan", "0300 111 2222", 900, "", ""],
      ["Ali Again", "03001234567", 10, "", ""],
      ["", "0333-0000000", 5, "", ""]
    ]);
    const job = ((await upload(file, "khata.xlsx", "CUSTOMERS")).body as unknown as ImportJobDetail).job;
    expect(job.counts).toMatchObject({ ready: 2, skipped: 1, invalid: 2 });
    await call(importRoute.POST, { method: "POST", token: owner, params: { id: job.id }, body: { action: "commit" } });

    const ali = await db.customer.findFirstOrThrow({ where: { name: "Ali Raza" }, include: { ledger: true } });
    expect(ali).toMatchObject({ phone: "03001234567", creditLimit: null });
    expect(ledgerBalance(ali.ledger)).toBe(2350);
    expect(ageLedger(ali.ledger, new Date()).buckets.days31to60).toBe(2350);
    const sana = await db.customer.findFirstOrThrow({ where: { name: "Sana Bibi" }, include: { ledger: true } });
    expect(Number(sana.creditLimit)).toBe(0);
    expect(ledgerBalance(sana.ledger)).toBe(-500);
    expect(await db.customer.count({ where: { branchId: t.branchA2.id } })).toBe(3);
    expect((await detail(job.id)).job.summary).toMatchObject({ customers: 2, owedToShop: 2350, advances: 500 });
  });

  it("brings in suppliers with what the shop owes them", async () => {
    await db.supplier.create({ data: { branchId: t.branchA2.id, name: "Old Distributor" } });
    const job = ((await upload(csv([["Supplier", "Phone", "Payable"], ["Muller & Phipps", "042-111222333", "48,200"], ["old distributor", "", "1000"]]), "suppliers.csv", "SUPPLIERS")).body as unknown as ImportJobDetail).job;
    await call(importRoute.POST, { method: "POST", token: owner, params: { id: job.id }, body: { action: "commit" } });
    const supplier = await db.supplier.findFirstOrThrow({ where: { name: "Muller & Phipps" }, include: { ledger: true } });
    expect(ledgerBalance(supplier.ledger)).toBe(48200);
    expect(await db.supplier.count({ where: { branchId: t.branchA2.id } })).toBe(2);
  });
});

describe("templates and access", () => {
  it("hands out templates whose headings map themselves", async () => {
    const response = await templateRoute.GET(new Request("http://localhost/x", { headers: { authorization: `Bearer ${owner}` } }), { params: Promise.resolve({ id: "stock" }) });
    expect(response.headers.get("content-type")).toContain("spreadsheetml");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await response.arrayBuffer());
    const headings = (book.worksheets[0].getRow(1).values as string[]).filter(Boolean);
    expect(headings).toContain("Item name");
    expect(book.worksheets[0].rowCount).toBe(1);
    book.worksheets[0].addRow(["Surbex Z", "", "", "", "1x30", "", "", "", "31/01/2028", 2, "", 380, 450, "B-2"]);
    const filled = Buffer.from(await book.xlsx.writeBuffer());
    const job = (await upload(filled, "filled-template.xlsx")).body as unknown as ImportJobDetail;
    expect(Object.keys(job.columnMap).sort()).toEqual(job.fields.map((field) => field.key).sort());
    expect(job.job.counts).toMatchObject({ ready: 1 });
  });

  it("keeps imports inside the pharmacy, and lets Pharmica staff run one for a shop", async () => {
    const job = ((await upload(STOCK_FILE, "stock.csv")).body as unknown as ImportJobDetail).job;
    expect((await call(importRoute.GET, { token: await webSession(t.ownerB.id), params: { id: job.id } })).status).toBe(404);
    expect((await call(importsRoute.POST, { method: "POST", token: await webSession(t.cashierA1.id), body: { branchId: t.branchA1.id, kind: "STOCK", fileName: "x.csv", content: "eA==" } })).status).toBe(403);
    expect((await upload(STOCK_FILE, "stock.csv", "STOCK", t.branchB1.id)).status).toBe(403);

    // An expired pharmacy cannot import by itself, but assisted setup by Pharmica staff still works.
    await db.subscription.update({ where: { organisationId: t.orgA.id }, data: { paidThrough: new Date(Date.now() - 40 * DAY) } });
    expect((await upload(csv([["Name", "Phone"], ["X", "0300"]]), "c.csv", "CUSTOMERS")).body.error?.code).toBe("SUBSCRIPTION_LAPSED");
    const admin = await webSession(t.admin.id);
    const assisted = await upload(csv([["Name", "Phone"], ["Assisted Customer", "03009998887"]]), "c.csv", "CUSTOMERS", t.branchA2.id, admin);
    expect(assisted.status).toBe(201);
    const listed = (await call(importsRoute.GET, { token: admin, path: `/x?organisationId=${t.orgA.id}` })).body.jobs as Array<{ createdBy: string }>;
    expect(listed[0].createdBy).toBe("admin");
  });
});
