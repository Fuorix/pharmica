import { globSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CreateTenantResponse, DuplicateCandidate, MasterListPage, PriceListRowItem, PriceListUploadSummary, ShopPriceReportGroup, SupportView, TenantDetail, TenantListItem } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { beforeEach, describe, expect, it } from "vitest";
import * as duplicatesRoute from "../app/api/v1/admin/catalogue/duplicates/route";
import * as reportsRoute from "../app/api/v1/admin/catalogue/reports/route";
import * as uploadRoute from "../app/api/v1/admin/catalogue/uploads/[id]/route";
import * as uploadsRoute from "../app/api/v1/admin/catalogue/uploads/route";
import * as tenantRoute from "../app/api/v1/admin/tenants/[id]/route";
import * as supportRoute from "../app/api/v1/admin/tenants/[id]/support/route";
import * as tenantsRoute from "../app/api/v1/admin/tenants/route";
import * as loginRoute from "../app/api/v1/auth/login/route";
import * as meRoute from "../app/api/v1/auth/me/route";
import * as passwordRoute from "../app/api/v1/auth/password/route";
import * as pinLoginRoute from "../app/api/v1/auth/pin-login/route";
import * as masterRoute from "../app/api/v1/catalogue/master/route";
import * as activateRoute from "../app/api/v1/devices/activate/route";
import * as masterListRoute from "../app/api/v1/pos/master-list/route";
import * as snapshotRoute from "../app/api/v1/pos/snapshot/route";
import * as syncRoute from "../app/api/v1/pos/sync/route";
import * as usersRoute from "../app/api/v1/users/route";
import { call, deviceSession, PIN, resetDatabase, seedTenants, webSession } from "./helpers";

let t: Awaited<ReturnType<typeof seedTenants>>;
let admin: string;
const DAY = 86_400_000;

beforeEach(async () => {
  await resetDatabase();
  t = await seedTenants();
  admin = await webSession(t.admin.id);
  await db.plan.create({ data: { code: "starter", name: "Starter", monthlyPrice: 3000, quarterlyDiscountPercent: 5, yearlyDiscountPercent: 15, maxBranches: 1, maxDevices: 2, features: ["reports"], trialDays: 14 } });
});

describe("super-admin isolation", () => {
  const appDir = fileURLToPath(new URL("../app", import.meta.url));
  const adminRoutes = globSync("api/v1/admin/**/route.ts", { cwd: appDir }).map((file) => ({ path: "/" + file.replace(/\\/g, "/").replace(/\/route\.ts$/, ""), url: pathToFileURL(`${appDir}/${file}`).href }));

  it("refuses every admin route to owners and cashiers, on the web and at the counter", async () => {
    expect(adminRoutes.length).toBeGreaterThanOrEqual(12);
    const tokens = { owner: await webSession(t.ownerA.id), cashier: await webSession(t.cashierA1.id), counter: await deviceSession(t.cashierA1.id, t.deviceA1.id) };
    const leaks: string[] = [];
    for (const route of adminRoutes) {
      const module = await import(route.url) as Record<string, unknown>;
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
        if (typeof module[method] !== "function") continue;
        for (const [role, token] of Object.entries(tokens)) {
          const response = await call(module[method] as Parameters<typeof call>[0], { method, path: route.path, token, params: { id: t.orgA.id }, body: method === "GET" ? undefined : {} });
          if (response.status !== 403) leaks.push(`${role} ${method} ${route.path} -> ${response.status}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("does not let an owner create a Pharmica admin", async () => {
    const response = await call(usersRoute.POST, { method: "POST", token: await webSession(t.ownerA.id), body: { name: "Sneaky", login: "sneaky@x.pk", credential: "long-enough-1", role: "super-admin" } });
    expect(response.status).toBe(403);
  });
});

async function onboard(overrides: Record<string, unknown> = {}) {
  const response = await call(tenantsRoute.POST, { method: "POST", token: admin, body: { pharmacyName: "Al-Shifa Medical", contactName: "Bilal", phone: "0300-1234567", city: "Multan", branchName: "Main", ownerName: "Bilal Ahmed", ownerLogin: "bilal@alshifa.pk", planCode: "starter", counters: 1, ...overrides } });
  expect(response.status).toBe(201);
  return response.body as unknown as CreateTenantResponse;
}

describe("tenant onboarding", () => {
  it("creates a pharmacy that can be activated end to end", async () => {
    const { tenant, temporaryPassword } = await onboard();
    expect(temporaryPassword).toMatch(/^\w{4}-\w{4}-\w{4}$/);
    expect(tenant.subscription).toMatchObject({ status: "TRIAL", plan: { code: "starter" }, daysLeft: 14 });
    expect(tenant.devices).toHaveLength(1);
    expect(tenant.checklist.filter((step) => step.done).map((step) => step.key)).toEqual([]);
    const owner = tenant.users[0];
    expect(owner).toMatchObject({ role: "owner", mustChangeCredential: true });
    expect(JSON.stringify(await db.user.findUniqueOrThrow({ where: { id: owner.id } }))).not.toContain(temporaryPassword);

    // The owner signs in with the temporary password and must choose their own before anything else.
    const login = await call(loginRoute.POST, { method: "POST", body: { login: "bilal@alshifa.pk", credential: temporaryPassword } });
    expect(login.body.user).toMatchObject({ mustChangeCredential: true });
    const token = (login.headers.get("set-cookie") ?? "").match(/pharmica_session=([^;]+)/)![1];
    expect((await call(usersRoute.GET, { token })).body.error?.code).toBe("CREDENTIAL_CHANGE_REQUIRED");
    expect((await call(passwordRoute.POST, { method: "POST", token, body: { currentCredential: "wrong", newCredential: "my-own-secret-1" } })).status).toBe(400);
    expect((await call(passwordRoute.POST, { method: "POST", token, body: { currentCredential: temporaryPassword, newCredential: "my-own-secret-1" } })).status).toBe(200);
    expect((await call(usersRoute.GET, { token })).status).toBe(200);
    expect((await call(loginRoute.POST, { method: "POST", body: { login: "bilal@alshifa.pk", credential: temporaryPassword } })).status).toBe(401);

    // The owner adds a cashier; the counter activates with the code from onboarding and the cashier signs in.
    await call(usersRoute.POST, { method: "POST", token, body: { name: "Kashif", login: "kashif-alshifa", role: "cashier", branchId: tenant.branches[0].id, pin: PIN } });
    const activated = await call(activateRoute.POST, { method: "POST", body: { activationCode: tenant.devices[0].activationCode } });
    expect(activated.status).toBe(201);
    const deviceToken = activated.body.deviceToken as string;
    expect((await call(snapshotRoute.GET, { deviceToken })).status).toBe(200);
    const cashier = await db.user.findUniqueOrThrow({ where: { login: "kashif-alshifa" } });
    expect((await call(pinLoginRoute.POST, { method: "POST", deviceToken, body: { userId: cashier.id, pin: PIN } })).status).toBe(200);

    const detail = (await call(tenantRoute.GET, { token: admin, params: { id: tenant.id } })).body.tenant as TenantDetail;
    expect(detail.devices[0].activationCode).toBeNull();
    expect(detail.checklist.filter((step) => step.done).map((step) => step.key)).toEqual(["owner", "counter", "staff"]);
    const listed = (await call(tenantsRoute.GET, { token: admin, path: "/api/v1/admin/tenants?q=multan" })).body.tenants as TenantListItem[];
    expect(listed).toMatchObject([{ name: "Al-Shifa Medical", status: "TRIAL", activeDevices: 1, onboardingDone: 3, onboardingTotal: 8 }]);
  });

  it("refuses a taken login, an unknown plan, and more counters than the plan allows", async () => {
    await onboard();
    const again = await call(tenantsRoute.POST, { method: "POST", token: admin, body: { pharmacyName: "X", contactName: "X", branchName: "X", ownerName: "X", ownerLogin: "bilal@alshifa.pk", planCode: "starter" } });
    expect(again.body.error).toMatchObject({ code: "TENANT_NOT_CREATED", message: "That owner login is already used" });
    expect((await call(tenantsRoute.POST, { method: "POST", token: admin, body: { pharmacyName: "X", contactName: "X", branchName: "X", ownerName: "X", ownerLogin: "x@x.pk", planCode: "gold" } })).body.error?.code).toBe("TENANT_NOT_CREATED");
    expect((await call(tenantsRoute.POST, { method: "POST", token: admin, body: { pharmacyName: "X", contactName: "X", branchName: "X", ownerName: "X", ownerLogin: "y@x.pk", planCode: "starter", counters: 3 } })).body.error?.message).toContain("allows 2 counters");
  });

  it("starts a no-trial pharmacy unpaid, with its first invoice due now", async () => {
    const { tenant } = await onboard({ trialDays: 0, period: "QUARTERLY" });
    expect(tenant.subscription?.status).toBe("GRACE");
    expect(tenant.invoices).toMatchObject([{ status: "OPEN", period: "QUARTERLY", total: 8550, balance: 8550 }]);
  });
});

describe("suspension", () => {
  it("signs everyone out and stops sync, without making the counter think it was deactivated", async () => {
    const owner = await webSession(t.ownerA.id);
    expect((await call(tenantRoute.PATCH, { method: "PATCH", token: admin, params: { id: t.orgA.id }, body: { isActive: false } })).body.error?.code).toBe("REASON_REQUIRED");
    expect((await call(tenantRoute.PATCH, { method: "PATCH", token: admin, params: { id: t.orgA.id }, body: { isActive: false, reason: "Fraud check" } })).status).toBe(200);

    expect((await call(meRoute.GET, { token: owner })).status).toBe(401);
    expect((await call(loginRoute.POST, { method: "POST", body: { login: "owner-a", credential: "correct-horse-battery" } })).body.error?.code).toBe("ORGANISATION_SUSPENDED");
    expect((await call(snapshotRoute.GET, { deviceToken: t.deviceA1.token })).body.error?.code).toBe("ORGANISATION_SUSPENDED");
    expect((await call(syncRoute.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { operations: [] } })).status).toBe(403);
    expect((await call(pinLoginRoute.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { userId: t.cashierA1.id, pin: PIN } })).status).toBe(403);
    // The other pharmacy is untouched.
    expect((await call(snapshotRoute.GET, { deviceToken: t.deviceB1.token })).status).toBe(200);

    await call(tenantRoute.PATCH, { method: "PATCH", token: admin, params: { id: t.orgA.id }, body: { isActive: true, reason: "Cleared" } });
    expect((await call(snapshotRoute.GET, { deviceToken: t.deviceA1.token })).status).toBe(200);
    expect((await db.auditLog.findMany({ where: { organisationId: t.orgA.id, action: { in: ["tenant.suspended", "tenant.restored"] } }, orderBy: { createdAt: "asc" } })).map((log) => log.action)).toEqual(["tenant.suspended", "tenant.restored"]);
  });

  it("resets a locked-out owner to a new temporary password", async () => {
    const reset = await call(tenantRoute.PATCH, { method: "PATCH", token: admin, params: { id: t.orgA.id }, body: { resetPasswordFor: t.ownerA.id } });
    const temporary = reset.body.temporaryPassword as string;
    expect(temporary).toBeTruthy();
    const login = await call(loginRoute.POST, { method: "POST", body: { login: "owner-a", credential: temporary } });
    expect(login.body.user).toMatchObject({ mustChangeCredential: true });
    expect((await call(tenantRoute.PATCH, { method: "PATCH", token: admin, params: { id: t.orgA.id }, body: { resetPasswordFor: t.ownerB.id } })).status).toBe(404);
  });
});

describe("support view", () => {
  it("shows counter health, stuck uploads, and the audit trail, without secrets", async () => {
    await db.device.update({ where: { id: t.deviceA1.id }, data: { diagnostics: { appVersion: "0.1.0", reportedAt: new Date().toISOString(), pending: 3, failed: 1, oldestPendingAt: null, lastSyncAt: null, lastSnapshotAt: null, lastError: "Server error 500", consecutiveFailures: 2, masterProducts: 40, online: true }, diagnosticsAt: new Date() } });
    await db.syncOperation.create({ data: { idempotencyKey: "op-broken", deviceId: t.deviceA1.id, branchId: t.branchA1.id, entityType: "sale", payload: {}, status: "FAILED", errorMessage: "Batch not found", retryCount: 2 } });
    for (let index = 0; index < 55; index++) await db.auditLog.create({ data: { organisationId: t.orgA.id, action: "test.event", entityType: "test", entityId: String(index), createdAt: new Date(Date.now() - index * 1000) } });

    const first = (await call(supportRoute.GET, { token: admin, params: { id: t.orgA.id } })).body as unknown as SupportView;
    expect(first.devices.find((device) => device.id === t.deviceA1.id)).toMatchObject({ activated: true, diagnostics: { pending: 3, lastError: "Server error 500" }, operations: { failed: 1, flaggedUnreviewed: 1 } });
    expect(first.problems).toMatchObject([{ id: "op-broken", status: "FAILED", error: "Batch not found" }]);
    expect(first.audit).toHaveLength(50);
    const second = (await call(supportRoute.GET, { token: admin, path: `/x?cursor=${first.nextAuditCursor}`, params: { id: t.orgA.id } })).body as unknown as SupportView;
    expect(second.audit.length).toBeGreaterThanOrEqual(5);
    expect(new Set([...first.audit, ...second.audit].map((entry) => entry.id)).size).toBe(first.audit.length + second.audit.length);
    const text = JSON.stringify(first);
    expect(text).not.toContain(t.deviceA1.secretHash!);
    expect(text).not.toContain("credentialHash");
  });
});

describe("catalogue curation", () => {
  const masterOf = async () => (await db.product.findUniqueOrThrow({ where: { id: t.productA1.id } })).masterProductId!;

  it("publishes shop-reported prices only after review, grouped across shops", async () => {
    const masterId = await masterOf();
    const productB1 = await db.product.create({ data: { branchId: t.branchB1.id, masterProductId: masterId, name: "Panadol 500mg" } });
    await db.priceChangeReport.createMany({ data: [
      { branchId: t.branchA1.id, productId: t.productA1.id, oldPrice: 100, newPrice: 112, source: "RECEIVING" },
      { branchId: t.branchB1.id, productId: productB1.id, oldPrice: 100, newPrice: 112, source: "RECEIVING" },
      { branchId: t.branchB1.id, productId: productB1.id, oldPrice: 100, newPrice: 115, source: "RECEIVING" }
    ] });
    const groups = (await call(reportsRoute.GET, { token: admin })).body.groups as ShopPriceReportGroup[];
    expect(groups.map((group) => [group.reportedPrice, group.shops, group.reports])).toEqual([[112, 2, 2], [115, 1, 1]]);
    expect(Number((await db.masterProduct.findUniqueOrThrow({ where: { id: masterId } })).officialRetailPrice)).toBe(100);

    expect((await call(reportsRoute.POST, { method: "POST", token: admin, body: { masterProductId: masterId, reportedPrice: 115, action: "dismiss" } })).status).toBe(400);
    expect((await call(reportsRoute.POST, { method: "POST", token: admin, body: { masterProductId: masterId, reportedPrice: 115, action: "dismiss", note: "Typo on one invoice" } })).body).toMatchObject({ reports: 1 });
    expect((await call(reportsRoute.POST, { method: "POST", token: admin, body: { masterProductId: masterId, reportedPrice: 112, action: "publish" } })).body).toMatchObject({ reports: 2, shops: 2 });

    expect(Number((await db.masterProduct.findUniqueOrThrow({ where: { id: masterId } })).officialRetailPrice)).toBe(112);
    expect(await db.masterPriceHistory.findFirst({ where: { masterProductId: masterId, source: "SHOP_REPORT" } })).toMatchObject({ reference: "Reported by 2 shops", recordedById: t.admin.id });
    expect((await db.priceChangeReport.findMany({ orderBy: { newPrice: "asc" } })).map((report) => [Number(report.newPrice), report.status, report.reviewedById])).toEqual([[112, "PUBLISHED", t.admin.id], [112, "PUBLISHED", t.admin.id], [115, "DISMISSED", t.admin.id]]);
    expect((await call(reportsRoute.GET, { token: admin })).body.groups).toEqual([]);
  });

  it("matches an uploaded price list, waits for review, and publishes approved rows only", async () => {
    const masterId = await masterOf();
    await db.masterProduct.update({ where: { id: masterId }, data: { barcode: "8964000111222" } });
    const augmentin = await db.masterProduct.create({ data: { name: "Augmentin 625mg", unitsPerPack: 1, tabletsPerStrip: 6, officialRetailPrice: 450 } });
    await db.masterPriceHistory.create({ data: { masterProductId: augmentin.id, price: 450, effectiveFrom: new Date(Date.now() - 100 * DAY), source: "SRO" } });
    await db.masterProduct.createMany({ data: [{ name: "Twin", unitsPerPack: 1 }, { name: "twin", unitsPerPack: 1 }] });
    const csv = ["Product Name,Barcode,Retail Price", "Panadol 500mg,8964000111222,\"1,10\"", "AUGMENTIN 625MG,,450", "Unknown Syrup,,99", "Twin,,10", "Broken,,abc"].join("\r\n");

    const created = await call(uploadsRoute.POST, { method: "POST", token: admin, body: { source: "SRO", reference: "SRO 1234(I)/2026", effectiveFrom: new Date(Date.now() - DAY).toISOString().slice(0, 10), fileName: "sro.csv", csv } });
    expect(created.status).toBe(201);
    const upload = created.body.upload as PriceListUploadSummary;
    expect(upload.counts).toEqual({ rows: 5, matched: 1, unchanged: 1, notFound: 1, ambiguous: 1, invalid: 1, approved: 1 });
    const rows = (await call(uploadRoute.GET, { token: admin, params: { id: upload.id } })).body.rows as PriceListRowItem[];
    expect(rows.map((row) => [row.line, row.match, row.price])).toEqual([[2, "MATCHED", 110], [3, "UNCHANGED", 450], [4, "NOT_FOUND", 99], [5, "AMBIGUOUS", 10], [6, "INVALID", null]]);
    expect(Number((await db.masterProduct.findUniqueOrThrow({ where: { id: masterId } })).officialRetailPrice)).toBe(100);

    // The reviewer matches the unknown row by hand and approves it, then publishes.
    await call(uploadRoute.PATCH, { method: "PATCH", token: admin, params: { id: upload.id }, body: { rowId: rows[2].id, masterProductId: augmentin.id } });
    const published = await call(uploadRoute.POST, { method: "POST", token: admin, params: { id: upload.id }, body: { action: "publish" } });
    expect(published.body).toMatchObject({ published: 2, upload: { status: "PUBLISHED", reviewedBy: "admin" } });
    expect(Number((await db.masterProduct.findUniqueOrThrow({ where: { id: masterId } })).officialRetailPrice)).toBe(110);
    expect(Number((await db.masterProduct.findUniqueOrThrow({ where: { id: augmentin.id } })).officialRetailPrice)).toBe(99);
    expect(await db.masterPriceHistory.count({ where: { reference: "SRO 1234(I)/2026", source: "SRO" } })).toBe(2);
    expect((await call(uploadRoute.POST, { method: "POST", token: admin, params: { id: upload.id }, body: { action: "publish" } })).status).toBe(409);
  });

  it("schedules a future-dated price list instead of applying it now", async () => {
    const masterId = await masterOf();
    const future = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    const upload = (await call(uploadsRoute.POST, { method: "POST", token: admin, body: { source: "COMPANY_PRICE_LIST", reference: "GSK list", effectiveFrom: future, csv: "name,price\nPanadol 500mg,125" } })).body.upload as PriceListUploadSummary;
    await call(uploadRoute.POST, { method: "POST", token: admin, params: { id: upload.id }, body: { action: "publish" } });
    expect(Number((await db.masterProduct.findUniqueOrThrow({ where: { id: masterId } })).officialRetailPrice)).toBe(100);
    expect(await db.masterPriceHistory.count({ where: { masterProductId: masterId, price: 125 } })).toBe(1);
  });

  it("merges a duplicate, keeping every shop item and its history, and hides it from counters", async () => {
    const keepId = await masterOf();
    const duplicate = await db.masterProduct.create({ data: { name: "Panadol 500mg", generic: "Paracetamol", unitsPerPack: 10, tabletsPerStrip: 10, barcode: "8964000999888" } });
    const sameShop = await db.product.create({ data: { branchId: t.branchA1.id, masterProductId: duplicate.id, name: "Panadol 500 (dup)" } });
    const otherShop = await db.product.create({ data: { branchId: t.branchB1.id, masterProductId: duplicate.id, name: "Panadol 500mg" } });

    const candidates = (await call(duplicatesRoute.GET, { token: admin })).body.candidates as DuplicateCandidate[];
    expect(candidates.find((group) => group.products.some((product) => product.id === duplicate.id))?.reason).toBe("Same name");
    const odd = await db.masterProduct.create({ data: { name: "Panadol 500mg", unitsPerPack: 20, tabletsPerStrip: 10 } });
    expect((await call(duplicatesRoute.POST, { method: "POST", token: admin, body: { keepId, mergeId: odd.id, reason: "Same" } })).body.error?.message).toContain("Pack sizes differ");

    const merged = await call(duplicatesRoute.POST, { method: "POST", token: admin, body: { keepId, mergeId: duplicate.id, reason: "Entered twice" } });
    expect(merged.body).toEqual({ relinked: 1, unlinked: 1 });
    expect(await db.product.findUniqueOrThrow({ where: { id: otherShop.id } })).toMatchObject({ masterProductId: keepId });
    expect(await db.product.findUniqueOrThrow({ where: { id: sameShop.id } })).toMatchObject({ masterProductId: null, unitsPerPack: 10, tabletsPerStrip: 10, generic: "Paracetamol" });
    expect(await db.masterProduct.findUniqueOrThrow({ where: { id: keepId } })).toMatchObject({ barcode: "8964000999888" });
    expect(await db.masterProductMerge.findFirst()).toMatchObject({ keptId: keepId, mergedId: duplicate.id, performedById: t.admin.id, branchProductsRelinked: 1, branchProductsUnlinked: 1 });

    const search = (await call(masterRoute.GET, { token: admin, path: "/x?q=panadol" })).body.products as Array<{ id: string }>;
    expect(search.map((product) => product.id)).not.toContain(duplicate.id);
    const page = (await call(masterListRoute.GET, { deviceToken: t.deviceB1.token })).body as unknown as MasterListPage;
    expect(page.products.find((product) => product.id === duplicate.id)?.mergedIntoId).toBe(keepId);

    // A counter that still offers the old entry receives into the kept one.
    const result = await call(syncRoute.POST, { method: "POST", deviceToken: t.deviceB1.token, body: { operations: [{ id: "op-recv", type: "purchase.receive", userId: t.ownerB.id, occurredAt: new Date().toISOString(), payload: { purchaseId: "p-merged", supplier: { name: "Dist" }, invoiceDiscount: 0, lines: [{ masterProductId: duplicate.id, batchNo: "M-1", expiryDate: new Date(Date.now() + 400 * DAY).toISOString().slice(0, 10), quantity: 1, bonusQuantity: 0, costPrice: 80, discount: 0, retailPrice: 100 }] } }] } });
    expect((result.body.results as Array<{ status: string }>)[0].status).toBe("applied");
    expect(await db.batch.findFirstOrThrow({ where: { batchNo: "M-1" }, include: { product: true } })).toMatchObject({ product: { id: otherShop.id, masterProductId: keepId } });
  });
});
