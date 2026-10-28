import { db } from "@pharmica/database/client";
import { beforeEach, describe, expect, it } from "vitest";
import * as link from "../app/api/v1/devices/link/route";
import * as deviceMe from "../app/api/v1/devices/me/route";
import * as devices from "../app/api/v1/devices/route";
import * as login from "../app/api/v1/auth/login/route";
import * as logout from "../app/api/v1/auth/logout/route";
import * as me from "../app/api/v1/auth/me/route";
import * as pinLogin from "../app/api/v1/auth/pin-login/route";
import * as posStaff from "../app/api/v1/pos/staff/route";
import * as sales from "../app/api/v1/sales/route";
import * as users from "../app/api/v1/users/route";
import { getSession } from "../src/auth/session";
import { call, deviceSession, PASSWORD, PIN, resetDatabase, seedTenants, webSession } from "./helpers";

let t: Awaited<ReturnType<typeof seedTenants>>;

beforeEach(async () => {
  await resetDatabase();
  t = await seedTenants();
});

const auditActions = async (action: string) => db.auditLog.count({ where: { action } });

function saleBody() {
  return { branchId: t.branchA1.id, paymentMethod: "cash", lines: [{ productId: t.productA1.id, quantity: 1, unit: "pack" }] };
}

describe("password login", () => {
  it("opens a session, sets the cookie, and audits the login", async () => {
    const response = await call(login.POST, { method: "POST", body: { login: "OWNER-A", credential: PASSWORD } });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/pharmica_session=.+HttpOnly/);
    expect(response.body).toMatchObject({ user: { id: t.ownerA.id, role: "owner", deviceId: null } });
    expect(await auditActions("auth.login")).toBe(1);
  });

  it("audits failures and locks the login after five attempts", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await call(login.POST, { method: "POST", body: { login: "owner-a", credential: "wrong-password" } })).status).toBe(401);
    }
    expect(await auditActions("auth.login_failed")).toBe(5);
    const locked = await call(login.POST, { method: "POST", body: { login: "owner-a", credential: PASSWORD } });
    expect(locked.status).toBe(429);
  });

  it("rejects deactivated users and PIN-only cashiers", async () => {
    await db.user.update({ where: { id: t.ownerA.id }, data: { isActive: false } });
    expect((await call(login.POST, { method: "POST", body: { login: "owner-a", credential: PASSWORD } })).status).toBe(401);
    await db.user.update({ where: { id: t.cashierA1.id }, data: { credentialHash: null } });
    expect((await call(login.POST, { method: "POST", body: { login: "cashier-a1", credential: PASSWORD } })).status).toBe(401);
  });
});

describe("sessions", () => {
  it("logout revokes the session and audits it", async () => {
    const token = await webSession(t.ownerA.id);
    expect((await call(me.GET, { token })).status).toBe(200);
    expect((await call(logout.POST, { method: "POST", token })).status).toBe(204);
    expect((await call(me.GET, { token })).status).toBe(401);
    expect(await auditActions("auth.logout")).toBe(1);
  });

  it("rejects expired sessions", async () => {
    const token = await webSession(t.ownerA.id);
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(me.GET, { token })).status).toBe(401);
  });

  it("extends a session that is past half of its lifetime", async () => {
    const token = await webSession(t.ownerA.id);
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    await db.session.updateMany({ data: { expiresAt: soon } });
    const session = await getSession(token);
    expect(session!.expiresAt.getTime()).toBeGreaterThan(soon.getTime() + 24 * 60 * 60 * 1000);
  });

  it("accepts the session cookie as well as a bearer token", async () => {
    const token = await webSession(t.ownerA.id);
    expect((await call(me.GET, { headers: { cookie: `pharmica_session=${token}` } })).status).toBe(200);
  });
});

describe("POS counter linking and PIN login", () => {
  const counter2 = () => db.device.create({ data: { branchId: t.branchA1.id, name: "AAAA22-2", counterNumber: 2 } });

  it("links a counter by its name, once, without a PIN", async () => {
    const device = await counter2();
    const first = await call(link.POST, { method: "POST", body: { deviceName: " aaaa22 - 02 " } });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ device: { id: device.id, name: "AAAA22-2", branchId: t.branchA1.id } });
    expect(first.body).not.toHaveProperty("userId");
    expect(String(first.body.deviceToken)).toMatch(new RegExp(`^${device.id}\\.`));
    expect((await call(deviceMe.GET, { deviceToken: String(first.body.deviceToken) })).status).toBe(200);
    expect(await auditActions("device.linked")).toBe(1);
    expect(await db.auditLog.findFirst({ where: { action: "device.linked" } })).toMatchObject({ userId: null });

    // A second computer cannot take the same counter while it is linked.
    const again = await call(link.POST, { method: "POST", body: { deviceName: "AAAA22-2" } });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("COUNTER_IN_USE");
  });

  it("refuses an unknown counter name, and still links when nobody at the branch has a PIN", async () => {
    await counter2();
    await db.user.update({ where: { id: t.ownerA.id }, data: { pinHash: null } });
    await db.user.update({ where: { id: t.cashierA1.id }, data: { pinHash: null } });
    const unknown = await call(link.POST, { method: "POST", body: { deviceName: "ZZZZ22-1" } });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error?.message).toBe("That counter name is not right");
    expect((await call(link.POST, { method: "POST", body: { deviceName: "not a counter" } })).status).toBe(400);
    expect((await call(link.POST, { method: "POST", body: { deviceName: "AAAA22-2" } })).status).toBe(201);
  });

  it("locks an unknown counter name after five wrong attempts", async () => {
    await counter2();
    for (let attempt = 0; attempt < 5; attempt++) await call(link.POST, { method: "POST", body: { deviceName: "ZZZZ22-1" } });
    expect((await call(link.POST, { method: "POST", body: { deviceName: "ZZZZ22-1" } })).status).toBe(429);
    expect((await call(link.POST, { method: "POST", body: { deviceName: "AAAA22-2" } })).status).toBe(201);
  });

  it("refuses a counter the owner turned off", async () => {
    const device = await counter2();
    await db.device.update({ where: { id: device.id }, data: { isActive: false } });
    expect((await call(link.POST, { method: "POST", body: { deviceName: "AAAA22-2" } })).status).toBe(403);
  });

  it("lets the linked counter add a cashier with its device token", async () => {
    const device = await counter2();
    const linked = await call(link.POST, { method: "POST", body: { deviceName: "AAAA22-2" } });
    expect(linked.status).toBe(201);
    const deviceToken = String(linked.body.deviceToken);
    expect((await call(posStaff.POST, { method: "POST", body: { name: "Ali", login: "ali.counter", pin: "5555", maxDiscountPercent: 5 } })).status).toBe(401);

    const created = await call(posStaff.POST, { method: "POST", deviceToken, body: { name: " Ali ", login: "Ali.Counter", pin: "5555", maxDiscountPercent: 5 } });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ name: "Ali", login: "ali.counter", role: "cashier", branchId: device.branchId, hasPin: true, maxDiscountPercent: 5 });
    expect(created.body.user).not.toHaveProperty("pinHash");
    expect(await auditActions("user.created")).toBe(1);

    const userId = (created.body.user as { id: string }).id;
    const names = ((await call(deviceMe.GET, { deviceToken })).body.users as Array<{ name: string }>).map((user) => user.name);
    expect(names).toContain("Ali");
    expect((await call(pinLogin.POST, { method: "POST", deviceToken, body: { userId, pin: "5555" } })).status).toBe(200);

    expect((await call(posStaff.POST, { method: "POST", deviceToken, body: { name: "Ali 2", login: "ali.counter", pin: "6666", maxDiscountPercent: 5 } })).status).toBe(409);
    expect((await call(posStaff.POST, { method: "POST", deviceToken, body: { name: "Bad", login: "bad-pin", pin: "12", maxDiscountPercent: 5 } })).status).toBe(400);
    expect((await call(posStaff.POST, { method: "POST", deviceToken, body: { name: "Bad", login: "bad-discount", pin: "5555", maxDiscountPercent: 150 } })).status).toBe(400);
    const omitted = await call(posStaff.POST, { method: "POST", deviceToken, body: { name: "No Limit", login: "no-limit", pin: "4444" } });
    expect(omitted.body.user).toMatchObject({ maxDiscountPercent: 5, branchId: device.branchId });
  });

  it("lists only staff of the device's branch who have a PIN", async () => {
    const response = await call(deviceMe.GET, { deviceToken: t.deviceA1.token });
    expect(response.status).toBe(200);
    const ids = (response.body.users as Array<{ id: string }>).map((user) => user.id);
    expect(ids.sort()).toEqual([t.ownerA.id, t.cashierA1.id].sort());
  });

  it("rejects a forged device token", async () => {
    expect((await call(deviceMe.GET, { deviceToken: `${t.deviceA1.id}.forged` })).status).toBe(401);
  });

  it("signs a cashier in with a PIN and binds the session to the device", async () => {
    const response = await call(pinLogin.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { userId: t.cashierA1.id, pin: PIN } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ user: { id: t.cashierA1.id, deviceId: t.deviceA1.id, branchId: t.branchA1.id } });
    const session = await getSession(String(response.body.token));
    expect(session?.user.deviceId).toBe(t.deviceA1.id);
  });

  it("refuses PIN login without a linked counter", async () => {
    expect((await call(pinLogin.POST, { method: "POST", body: { userId: t.cashierA1.id, pin: PIN } })).status).toBe(401);
  });

  it("refuses staff from another branch or tenant on this device", async () => {
    expect((await call(pinLogin.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { userId: t.cashierA2.id, pin: PIN } })).status).toBe(401);
    expect((await call(pinLogin.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { userId: t.ownerB.id, pin: PIN } })).status).toBe(401);
    expect((await call(pinLogin.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { userId: t.admin.id, pin: PIN } })).status).toBe(401);
  });

  it("locks a PIN after five wrong attempts", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await call(pinLogin.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { userId: t.cashierA1.id, pin: "0000" } });
    }
    expect((await call(pinLogin.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { userId: t.cashierA1.id, pin: PIN } })).status).toBe(429);
  });

  it("gives an owner on the POS only the device's branch", async () => {
    const response = await call(pinLogin.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { userId: t.ownerA.id, pin: PIN } });
    expect(response.body).toMatchObject({ user: { branchId: t.branchA1.id } });
  });
});

describe("sales require an active device", () => {
  it("lets a cashier sell from an active device", async () => {
    const token = await deviceSession(t.cashierA1.id, t.deviceA1.id);
    const response = await call(sales.POST, { method: "POST", token, body: saleBody() });
    expect(response.status).toBe(201);
  });

  it("refuses sales from a web session", async () => {
    const token = await webSession(t.ownerA.id);
    const response = await call(sales.POST, { method: "POST", token, body: saleBody() });
    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe("DEVICE_SESSION_REQUIRED");
  });

  it("stops a deactivated device from creating sales or signing in", async () => {
    const cashierToken = await deviceSession(t.cashierA1.id, t.deviceA1.id);
    const ownerToken = await webSession(t.ownerA.id);

    const deactivated = await call(devices.PATCH, { method: "PATCH", token: ownerToken, body: { deviceId: t.deviceA1.id, isActive: false } });
    expect(deactivated.status).toBe(200);
    expect(await auditActions("device.deactivated")).toBe(1);

    expect((await call(sales.POST, { method: "POST", token: cashierToken, body: saleBody() })).status).toBe(401);
    expect((await call(pinLogin.POST, { method: "POST", deviceToken: t.deviceA1.token, body: { userId: t.cashierA1.id, pin: PIN } })).status).toBe(401);
    expect(await db.sale.count()).toBe(0);
  });

  it("unlinks a counter so the old computer stops and another computer can link it", async () => {
    const ownerToken = await webSession(t.ownerA.id);
    const response = await call(devices.PATCH, { method: "PATCH", token: ownerToken, body: { deviceId: t.deviceA1.id, unlink: true } });
    expect(response.status).toBe(200);
    expect(response.body.device).toMatchObject({ name: "AAAA22-1", activatedAt: null });
    expect(response.body.device).not.toHaveProperty("secretHash");
    expect(await auditActions("device.unlinked")).toBe(1);
    expect((await call(deviceMe.GET, { deviceToken: t.deviceA1.token })).status).toBe(401);
    expect((await call(link.POST, { method: "POST", body: { deviceName: "AAAA22-1" } })).status).toBe(201);
  });
});

describe("adding counters", () => {
  it("names counters after the shop code with the next free number, and refuses a used number", async () => {
    const ownerToken = await webSession(t.ownerA.id);
    const listed = await call(devices.GET, { token: ownerToken });
    expect(listed.body).toMatchObject({ shopCode: "AAAA22", devices: [{ name: "AAAA22-1", counterNumber: 1 }] });

    const next = await call(devices.POST, { method: "POST", token: ownerToken, body: { branchId: t.branchA2.id } });
    expect(next.status).toBe(201);
    expect(next.body.device).toMatchObject({ name: "AAAA22-2", counterNumber: 2, branchId: t.branchA2.id });

    const chosen = await call(devices.POST, { method: "POST", token: ownerToken, body: { branchId: t.branchA1.id, counterNumber: 5 } });
    expect(chosen.body.device).toMatchObject({ name: "AAAA22-5" });
    const taken = await call(devices.POST, { method: "POST", token: ownerToken, body: { branchId: t.branchA1.id, counterNumber: 2 } });
    expect(taken.status).toBe(409);
    expect((await call(devices.POST, { method: "POST", token: ownerToken, body: { branchId: t.branchA1.id, counterNumber: 0 } })).status).toBe(400);
  });

  it("lets another pharmacy use the same counter numbers", async () => {
    const response = await call(devices.POST, { method: "POST", token: await webSession(t.ownerB.id), body: { branchId: t.branchB1.id } });
    expect(response.body.device).toMatchObject({ name: "BBBB22-2" });
  });
});

describe("user management", () => {
  it("lets an owner add a cashier with a branch and PIN", async () => {
    const token = await webSession(t.ownerA.id);
    const response = await call(users.POST, { method: "POST", token, body: { name: "New Cashier", login: "new-cashier", role: "cashier", branchId: t.branchA1.id, pin: "5555" } });
    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ role: "cashier", hasPin: true, organisationId: t.orgA.id });
    expect(response.body.user).not.toHaveProperty("pinHash");
    expect(await auditActions("user.created")).toBe(1);
  });

  it("validates cashier and PIN requirements", async () => {
    const token = await webSession(t.ownerA.id);
    expect((await call(users.POST, { method: "POST", token, body: { name: "X", login: "x", role: "cashier", pin: "5555" } })).status).toBe(400);
    expect((await call(users.POST, { method: "POST", token, body: { name: "X", login: "x", role: "cashier", branchId: t.branchA1.id, pin: "12" } })).status).toBe(400);
  });

  it("stops owners from creating admins or managing other tenants", async () => {
    const token = await webSession(t.ownerA.id);
    expect((await call(users.POST, { method: "POST", token, body: { name: "X", login: "x", role: "super-admin", credential: PASSWORD } })).status).toBe(403);
    expect((await call(users.PATCH, { method: "PATCH", token, body: { userId: t.ownerB.id, isActive: false } })).status).toBe(403);
    expect((await call(users.PATCH, { method: "PATCH", token, body: { userId: t.admin.id, isActive: false } })).status).toBe(403);
  });

  it("audits role changes and signs the user out everywhere", async () => {
    const ownerToken = await webSession(t.ownerA.id);
    const cashierToken = await deviceSession(t.cashierA1.id, t.deviceA1.id);
    const response = await call(users.PATCH, { method: "PATCH", token: ownerToken, body: { userId: t.cashierA1.id, role: "owner" } });
    expect(response.status).toBe(200);
    expect(await auditActions("user.role_changed")).toBe(1);
    expect((await call(me.GET, { token: cashierToken })).status).toBe(401);
  });

  it("deactivating a user ends their sessions", async () => {
    const ownerToken = await webSession(t.ownerA.id);
    const cashierToken = await deviceSession(t.cashierA1.id, t.deviceA1.id);
    await call(users.PATCH, { method: "PATCH", token: ownerToken, body: { userId: t.cashierA1.id, isActive: false } });
    expect((await call(sales.POST, { method: "POST", token: cashierToken, body: saleBody() })).status).toBe(401);
    expect(await auditActions("user.deactivated")).toBe(1);
  });

  it("stops an owner from deactivating themselves", async () => {
    const token = await webSession(t.ownerA.id);
    expect((await call(users.PATCH, { method: "PATCH", token, body: { userId: t.ownerA.id, isActive: false } })).status).toBe(409);
  });

  it("lets the Pharmica admin manage any tenant", async () => {
    const token = await webSession(t.admin.id);
    const response = await call(users.POST, { method: "POST", token, body: { organisationId: t.orgB.id, name: "B Cashier", login: "b-cashier", role: "cashier", branchId: t.branchB1.id, pin: "5555" } });
    expect(response.status).toBe(201);
  });
});
