import { globSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { db } from "@pharmica/database/client";
import { beforeAll, describe, expect, it } from "vitest";
import { call, deviceSession, resetDatabase, seedTenants, webSession } from "./helpers";

const appDir = fileURLToPath(new URL("../app", import.meta.url));
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

/** Routes that are reachable without a user session, by design. */
const PUBLIC = new Set([
  "GET /health",
  "GET /api/v1/health",
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/logout",
  "POST /api/v1/auth/pin-login",
  "POST /api/v1/devices/activate"
]);

const routes = globSync("**/route.ts", { cwd: appDir }).map((file) => ({
  path: "/" + file.replace(/\\/g, "/").replace(/\/?route\.ts$/, ""),
  url: pathToFileURL(`${appDir}/${file}`).href
}));

async function handlersOf(url: string) {
  const module = await import(url) as Record<string, unknown>;
  return METHODS.filter((method) => typeof module[method] === "function").map((method) => ({ method, handler: module[method] as Parameters<typeof call>[0] }));
}

describe("every API route", () => {
  it("is discovered", () => {
    expect(routes.length).toBeGreaterThan(25);
  });

  it("rejects requests without a session, except the public routes", async () => {
    const unprotected: string[] = [];
    for (const route of routes) {
      for (const { method, handler } of await handlersOf(route.url)) {
        const key = `${method} ${route.path}`;
        if (PUBLIC.has(key)) continue;
        const response = await call(handler, { method, path: route.path, params: { id: "missing" }, body: method === "GET" ? undefined : {} });
        if (response.status !== 401) unprotected.push(`${key} -> ${response.status}`);
      }
    }
    expect(unprotected).toEqual([]);
  });
});

describe("role and tenant boundaries", () => {
  let t: Awaited<ReturnType<typeof seedTenants>>;
  let ownerB: string;
  let cashierA1: string;
  let cashierA1Device: string;

  beforeAll(async () => {
    await resetDatabase();
    t = await seedTenants();
    ownerB = await webSession(t.ownerB.id);
    cashierA1 = await webSession(t.cashierA1.id);
    cashierA1Device = await deviceSession(t.cashierA1.id, t.deviceA1.id);
  });

  async function route(path: string) {
    const match = routes.find((candidate) => candidate.path === path);
    if (!match) throw new Error(`Unknown route ${path}`);
    return Object.fromEntries((await handlersOf(match.url)).map(({ method, handler }) => [method, handler]));
  }

  const ownerOnly: Array<[string, string]> = [
    ["GET", "/api/v1/users"], ["POST", "/api/v1/users"], ["PATCH", "/api/v1/users"],
    ["GET", "/api/v1/devices"], ["POST", "/api/v1/devices"], ["PATCH", "/api/v1/devices"],
    ["GET", "/api/v1/audit-logs"], ["GET", "/api/v1/suppliers"], ["GET", "/api/v1/price-reports"],
    ["GET", "/api/v1/catalogue/master"], ["POST", "/api/v1/catalogue"], ["PATCH", "/api/v1/catalogue"], ["POST", "/api/v1/catalogue/master"], ["GET", "/api/v1/controlled-drugs"],
    ["GET", "/api/v1/sync/conflicts"], ["GET", "/api/v1/purchases"], ["POST", "/api/v1/purchases"], ["PATCH", "/api/v1/inventory"], ["GET", "/api/v1/inventory/ledger"]
  ];

  it.each(ownerOnly)("forbids cashiers: %s %s", async (method, path) => {
    const handler = (await route(path))[method];
    const response = await call(handler, { method, path, token: cashierA1, body: method === "GET" ? undefined : {} });
    expect(response.status).toBe(403);
  });

  const branchReads = ["/api/v1/catalogue", "/api/v1/inventory", "/api/v1/sales", "/api/v1/shifts", "/api/v1/held-bills", "/api/v1/customers", "/api/v1/suppliers", "/api/v1/price-reports", "/api/v1/controlled-drugs"];

  it.each(branchReads)("forbids another tenant's owner from reading branch data: %s", async (path) => {
    const response = await call((await route(path)).GET, { path: `${path}?branchId=${t.branchA1.id}`, token: ownerB });
    expect(response.status).toBe(403);
  });

  it.each(["/api/v1/catalogue", "/api/v1/inventory", "/api/v1/sales", "/api/v1/shifts", "/api/v1/held-bills", "/api/v1/customers"])(
    "forbids a cashier from reading another branch of their own organisation: %s",
    async (path) => {
      const response = await call((await route(path)).GET, { path: `${path}?branchId=${t.branchA2.id}`, token: cashierA1Device });
      expect(response.status).toBe(403);
    }
  );

  it.each(["/api/v1/users", "/api/v1/devices", "/api/v1/audit-logs", "/api/v1/branches"])("forbids another tenant's owner from reading organisation data: %s", async (path) => {
    const response = await call((await route(path)).GET, { path: `${path}?organisationId=${t.orgA.id}`, token: ownerB });
    expect(response.status).toBe(403);
  });

  it("shows a cashier only their own branch", async () => {
    const response = await call((await route("/api/v1/branches")).GET, { path: "/api/v1/branches", token: cashierA1Device });
    expect(response.body.branches).toEqual([{ id: t.branchA1.id, name: "A1" }]);
  });

  it("forbids another tenant's owner from changing a sale, customer ledger, or supplier ledger", async () => {
    const customer = await db.customer.create({ data: { branchId: t.branchA1.id, name: "Ali" } });
    const supplier = await db.supplier.create({ data: { branchId: t.branchA1.id, name: "Distributor" } });
    const sale = await db.sale.create({ data: { branchId: t.branchA1.id, userId: t.cashierA1.id, subtotal: 100, discount: 0, total: 100, paymentMethod: "CASH" } });

    expect((await call((await route("/api/v1/sales/[id]")).PATCH, { method: "PATCH", token: ownerB, params: { id: sale.id }, body: { action: "void", reason: "x" } })).status).toBe(403);
    expect((await call((await route("/api/v1/customers/[id]/ledger")).GET, { token: ownerB, params: { id: customer.id } })).status).toBe(403);
    expect((await call((await route("/api/v1/customers/[id]/ledger")).POST, { method: "POST", token: ownerB, params: { id: customer.id }, body: { type: "PAYMENT", amount: 10 } })).status).toBe(403);
    expect((await call((await route("/api/v1/suppliers/[id]/ledger")).GET, { token: ownerB, params: { id: supplier.id } })).status).toBe(403);
  });
});
