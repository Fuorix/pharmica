import { createHmac } from "node:crypto";
import type { BillingOverview, CollectionsDashboard, TenantDetail } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as collectionsRoute from "../app/api/v1/admin/collections/route";
import * as invoicesRoute from "../app/api/v1/admin/invoices/route";
import * as paymentsRoute from "../app/api/v1/admin/payments/route";
import * as subscriptionRoute from "../app/api/v1/admin/tenants/[id]/subscription/route";
import * as callbackRoute from "../app/api/v1/billing/callback/[id]/route";
import * as billingRoute from "../app/api/v1/billing/route";
import * as activateRoute from "../app/api/v1/devices/activate/route";
import * as devicesRoute from "../app/api/v1/devices/route";
import * as exportRoute from "../app/api/v1/export/route";
import * as snapshotRoute from "../app/api/v1/pos/snapshot/route";
import * as syncRoute from "../app/api/v1/pos/sync/route";
import * as cashBookRoute from "../app/api/v1/reports/cash-book/route";
import * as dashboardRoute from "../app/api/v1/reports/dashboard/route";
import * as usersRoute from "../app/api/v1/users/route";
import { refreshSubscription } from "../src/billing/subscriptions";
import { call, resetDatabase, seedTenants, webSession } from "./helpers";

let t: Awaited<ReturnType<typeof seedTenants>>;
let owner: string;
let admin: string;
const DAY = 86_400_000;

beforeEach(async () => {
  await resetDatabase();
  t = await seedTenants();
  owner = await webSession(t.ownerA.id);
  admin = await webSession(t.admin.id);
});

/** Moves org A paid-through date to `days` from now (negative = in the past). */
async function paidThrough(days: number, isTrial = false) {
  await db.subscription.update({ where: { organisationId: t.orgA.id }, data: { paidThrough: new Date(Date.now() + days * DAY), isTrial } });
}

const events = async () => (await db.subscriptionEvent.findMany({ where: { subscription: { organisationId: t.orgA.id } }, orderBy: { createdAt: "asc" } })).map((event) => [event.type, event.fromStatus, event.toStatus]);
const openInvoice = () => db.subscriptionInvoice.findFirstOrThrow({ where: { organisationId: t.orgA.id, status: "OPEN" } });

describe("subscription transitions", () => {
  it("moves to grace and then expiry once each, with one renewal invoice", async () => {
    await paidThrough(-1);
    await refreshSubscription(t.orgA.id);
    await refreshSubscription(t.orgA.id);
    expect(await events()).toEqual([["status_changed", "ACTIVE", "GRACE"], ["invoice_issued", null, null]]);
    expect(await db.subscriptionInvoice.count({ where: { organisationId: t.orgA.id } })).toBe(1);

    await paidThrough(-31);
    await refreshSubscription(t.orgA.id);
    expect((await events()).at(-1)).toEqual(["status_changed", "GRACE", "EXPIRED"]);
    expect(await db.subscriptionInvoice.count({ where: { organisationId: t.orgA.id } })).toBe(1);
  });

  it("issues the renewal invoice a week ahead while everything still works", async () => {
    await paidThrough(5);
    await refreshSubscription(t.orgA.id);
    const invoice = await openInvoice();
    expect(invoice).toMatchObject({ period: "MONTHLY", months: 1 });
    expect(Number(invoice.total)).toBe(6000);
    expect(invoice.periodStart.getTime()).toBe((await db.subscription.findUniqueOrThrow({ where: { organisationId: t.orgA.id } })).paidThrough.getTime());
    expect((await call(dashboardRoute.GET, { token: owner })).status).toBe(200);
  });

  it("keeps subscription history append-only", async () => {
    await paidThrough(-1);
    await refreshSubscription(t.orgA.id);
    const event = await db.subscriptionEvent.findFirstOrThrow();
    await expect(db.subscriptionEvent.update({ where: { id: event.id }, data: { reason: "edited" } })).rejects.toThrow(/cannot be changed/);
    await expect(db.subscriptionEvent.delete({ where: { id: event.id } })).rejects.toThrow(/cannot be changed/);
  });
});

describe("grace mode", () => {
  it("pauses reports and cloud sync but never export or the subscription page", async () => {
    await paidThrough(-2);
    const dashboard = await call(dashboardRoute.GET, { token: owner });
    expect(dashboard.status).toBe(402);
    expect(dashboard.body.error).toMatchObject({ code: "SUBSCRIPTION_LAPSED", details: { status: "GRACE" } });
    expect((await call(syncRoute.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { operations: [] } })).status).toBe(402);
    expect((await call(snapshotRoute.GET, { deviceToken: t.deviceA1.token })).body.error?.code).toBe("SUBSCRIPTION_LAPSED");

    const exported = await exportRoute.GET(new Request("http://localhost:4000/api/v1/export", { headers: { authorization: `Bearer ${owner}` } }));
    expect(exported.status).toBe(200);
    const billing = (await call(billingRoute.GET, { token: owner })).body as unknown as BillingOverview;
    expect(billing.subscription).toMatchObject({ status: "GRACE", access: { billing: true, export: true, sync: false, reports: false, manage: true } });
    expect(billing.invoices).toMatchObject([{ status: "OPEN", balance: 6000 }]);
    // Managing the shop still works in grace; the other pharmacy is unaffected.
    expect((await call(devicesRoute.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, name: "Counter 2" } })).status).toBe(201);
    expect((await call(snapshotRoute.GET, { deviceToken: t.deviceB1.token })).status).toBe(200);
  });

  it("once expired, also blocks new counters, staff, and activations", async () => {
    const device = await db.device.create({ data: { branchId: t.branchA1.id, name: "Spare", activationCode: "SPARE-CODE-1" } });
    await paidThrough(-40);
    expect((await call(devicesRoute.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, name: "Counter 3" } })).body.error?.code).toBe("SUBSCRIPTION_LAPSED");
    expect((await call(usersRoute.POST, { method: "POST", token: owner, body: { name: "New", login: "new-cashier", role: "cashier", branchId: t.branchA1.id, pin: "5555" } })).status).toBe(402);
    expect((await call(activateRoute.POST, { method: "POST", body: { activationCode: device.activationCode } })).status).toBe(402);
    expect(await db.device.findUniqueOrThrow({ where: { id: device.id } })).toMatchObject({ secretHash: null });
  });
});

describe("plan features and limits", () => {
  it("keeps accounting for plans that include it, and counts active counters", async () => {
    const starter = await db.plan.create({ data: { code: "starter", name: "Starter", monthlyPrice: 3000, maxBranches: 2, maxDevices: 2, features: ["reports"] } });
    await db.subscription.update({ where: { organisationId: t.orgA.id }, data: { planId: starter.id } });
    expect((await call(dashboardRoute.GET, { token: owner })).status).toBe(200);
    const cashBook = await call(cashBookRoute.GET, { token: owner });
    expect(cashBook.body.error).toMatchObject({ code: "FEATURE_NOT_IN_PLAN", details: { feature: "accounting", plan: "starter" } });

    expect((await call(devicesRoute.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, name: "Counter 2" } })).status).toBe(201);
    const third = await call(devicesRoute.POST, { method: "POST", token: owner, body: { branchId: t.branchA1.id, name: "Counter 3" } });
    expect(third.body.error).toMatchObject({ code: "PLAN_LIMIT_REACHED" });
    expect(third.body.error?.message).toContain("2 active counters");
  });

  it("refuses a downgrade the pharmacy has outgrown", async () => {
    await db.plan.create({ data: { code: "solo", name: "Solo", monthlyPrice: 2000, maxBranches: 1, maxDevices: 1, features: ["reports"] } });
    expect((await call(billingRoute.POST, { method: "POST", token: owner, body: { period: "MONTHLY", planCode: "solo" } })).body.error?.code).toBe("PLAN_TOO_SMALL");
  });
});

describe("payments", () => {
  it("extends an on-time renewal from the old paid-through date", async () => {
    await paidThrough(3);
    const before = (await db.subscription.findUniqueOrThrow({ where: { organisationId: t.orgA.id } })).paidThrough;
    await refreshSubscription(t.orgA.id);
    const invoice = await openInvoice();

    const partial = await call(paymentsRoute.POST, { method: "POST", token: admin, body: { invoiceId: invoice.id, amount: 2000, method: "CASH", reference: "RB-0012" } });
    expect(partial.body).toMatchObject({ invoicePaid: false });
    expect((await call(paymentsRoute.POST, { method: "POST", token: admin, body: { invoiceId: invoice.id, amount: 4500, method: "CASH", reference: "RB-0013" } })).body.error?.code).toBe("OVERPAYMENT");
    const rest = await call(paymentsRoute.POST, { method: "POST", token: admin, body: { invoiceId: invoice.id, amount: 4000, method: "BANK_TRANSFER", reference: "HBL-778" } });
    expect(rest.body).toMatchObject({ invoicePaid: true });

    const after = await db.subscription.findUniqueOrThrow({ where: { organisationId: t.orgA.id } });
    const expected = new Date(before);
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    expect(after.paidThrough.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
    const billing = (await call(billingRoute.GET, { token: owner })).body as unknown as BillingOverview;
    expect(billing.payments.map((payment) => [payment.reference, payment.amount, payment.invoiceNumber])).toEqual([["HBL-778", 4000, invoice.number], ["RB-0012", 2000, invoice.number]]);
    expect(billing.invoices[0]).toMatchObject({ status: "PAID", balance: 0 });
  });

  it("restarts an expired pharmacy from the day it pays, and turns sync back on", async () => {
    await paidThrough(-45);
    await refreshSubscription(t.orgA.id);
    const invoice = await openInvoice();
    await call(paymentsRoute.POST, { method: "POST", token: admin, body: { invoiceId: invoice.id, amount: 6000, method: "CASH", reference: "RB-0099" } });
    const after = await db.subscription.findUniqueOrThrow({ where: { organisationId: t.orgA.id } });
    expect(after.status).toBe("ACTIVE");
    expect(Math.round((after.paidThrough.getTime() - Date.now()) / DAY)).toBeGreaterThanOrEqual(28);
    expect((await call(snapshotRoute.GET, { deviceToken: t.deviceA1.token })).status).toBe(200);
    expect((await events()).map(([type, , to]) => `${type}${to ? `:${to}` : ""}`)).toEqual(["status_changed:EXPIRED", "invoice_issued", "payment_received", "period_paid", "status_changed:ACTIVE"]);
  });

  it("re-prices the open invoice when the owner chooses a longer period, voiding the old one", async () => {
    await paidThrough(4);
    await refreshSubscription(t.orgA.id);
    const first = await openInvoice();
    const yearly = (await call(billingRoute.POST, { method: "POST", token: owner, body: { period: "YEARLY" } })).body as unknown as BillingOverview;
    expect(yearly.invoices.find((invoice) => invoice.status === "OPEN")).toMatchObject({ period: "YEARLY", subtotal: 72000, discount: 10800, total: 61200 });
    expect(await db.subscriptionInvoice.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "VOID", voidReason: "Replaced by a yearly Pro invoice" });
  });

  it("lets staff void a mistaken invoice but never one with money on it", async () => {
    await paidThrough(4);
    await refreshSubscription(t.orgA.id);
    const invoice = await openInvoice();
    await call(paymentsRoute.POST, { method: "POST", token: admin, body: { invoiceId: invoice.id, amount: 100, method: "CASH", reference: "RB-1" } });
    expect((await call(invoicesRoute.PATCH, { method: "PATCH", token: admin, body: { invoiceId: invoice.id, reason: "Wrong" } })).body.error?.code).toBe("INVOICE_HAS_PAYMENTS");
  });

  it("records admin changes with a reason in the history", async () => {
    await paidThrough(-3);
    const extended = await call(subscriptionRoute.PATCH, { method: "PATCH", token: admin, params: { id: t.orgA.id }, body: { extendDays: 7, reason: "Promised to pay on Friday" } });
    expect((extended.body.tenant as TenantDetail).subscription).toMatchObject({ status: "ACTIVE", daysLeft: 7 });
    expect((await call(subscriptionRoute.PATCH, { method: "PATCH", token: admin, params: { id: t.orgA.id }, body: { reason: "Nothing" } })).status).toBe(400);
    const history = (extended.body.tenant as TenantDetail).events.map((event) => event.reason);
    expect(history.some((reason) => reason?.includes("extended 7 days: Promised to pay on Friday"))).toBe(true);
  });
});

describe("online payment callbacks", () => {
  const SECRET = "test-webhook-secret";
  beforeEach(() => { process.env.PAYMENT_WEBHOOK_SECRET_JAZZCASH = SECRET; });
  afterEach(() => { delete process.env.PAYMENT_WEBHOOK_SECRET_JAZZCASH; });
  const sign = (body: unknown) => `sha256=${createHmac("sha256", SECRET).update(JSON.stringify(body)).digest("hex")}`;
  const deliver = (body: unknown, signature = sign(body), provider = "jazzcash") => call(callbackRoute.POST, { method: "POST", params: { id: provider }, body, headers: { "x-pharmica-signature": signature } });

  it("refuses unsigned, forged, or unconfigured callbacks", async () => {
    const body = { transactionId: "T1", invoiceNumber: "PH-2026-000001", amount: 6000, status: "SUCCESS" };
    expect((await deliver(body, "sha256=forged")).status).toBe(401);
    expect((await deliver(body, sign(body), "easypaisa")).status).toBe(401);
    expect((await deliver(body, sign(body), "paypal")).status).toBe(404);
    expect(await db.subscriptionPayment.count()).toBe(0);
  });

  it("applies a payment once however many times the provider repeats it", async () => {
    await paidThrough(2);
    await refreshSubscription(t.orgA.id);
    const invoice = await openInvoice();
    const body = { transactionId: "JC-55501", invoiceNumber: invoice.number, amount: 6000, status: "SUCCESS" };
    const [a, b] = await Promise.all([deliver(body), deliver(body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const again = await deliver(body);
    expect(again.body).toMatchObject({ duplicate: true });
    expect(await db.subscriptionPayment.count()).toBe(1);
    expect(await db.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: "PAID" });
    expect(await db.subscriptionEvent.count({ where: { type: "period_paid" } })).toBe(1);
  });

  it("keeps a payment that does not match as unmatched until staff match it", async () => {
    await paidThrough(2);
    await refreshSubscription(t.orgA.id);
    const invoice = await openInvoice();
    const wrong = await deliver({ transactionId: "JC-1", invoiceNumber: invoice.number, amount: 5000, status: "SUCCESS" });
    expect(wrong.body).toMatchObject({ status: "UNMATCHED", applied: false });
    expect((await deliver({ transactionId: "JC-2", invoiceNumber: "PH-1999-000001", amount: 6000, status: "SUCCESS" })).body).toMatchObject({ status: "UNMATCHED" });
    expect((await deliver({ transactionId: "JC-3", invoiceNumber: invoice.number, amount: 6000, status: "FAILED" })).body).toMatchObject({ status: "FAILED" });
    expect(await db.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: "OPEN" });

    const dashboard = (await call(collectionsRoute.GET, { token: admin })).body as unknown as CollectionsDashboard;
    expect(dashboard.unmatchedPayments.map((payment) => payment.reference)).toEqual(["JC-2", "JC-1"]);
    // The shop topped up the difference in cash; staff match the online part to the invoice.
    await call(paymentsRoute.POST, { method: "POST", token: admin, body: { invoiceId: invoice.id, amount: 1000, method: "CASH", reference: "RB-7" } });
    const matched = await call(paymentsRoute.PATCH, { method: "PATCH", token: admin, body: { paymentId: wrong.body.paymentId, invoiceId: invoice.id } });
    expect(matched.body).toMatchObject({ matched: true, invoicePaid: true });
    expect((await db.subscription.findUniqueOrThrow({ where: { organisationId: t.orgA.id } })).isTrial).toBe(false);
  });
});

describe("collections dashboard", () => {
  it("counts states, monthly revenue, and overdue shops", async () => {
    await paidThrough(-5);
    await refreshSubscription(t.orgA.id);
    const dashboard = (await call(collectionsRoute.GET, { token: admin })).body as unknown as CollectionsDashboard;
    expect(dashboard.counts).toMatchObject({ ACTIVE: 1, GRACE: 1 });
    expect(dashboard.mrr).toBe(6000);
    expect(dashboard.overdue).toMatchObject([{ name: "Org A", status: "GRACE", balance: 6000 }]);
    expect(dashboard.outstanding).toBe(6000);
  });
});
