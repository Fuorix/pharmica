import { db } from "@pharmica/database/client";
import { beforeEach, describe, expect, it } from "vitest";
import * as activate from "../app/api/v1/devices/activate/route";
import * as deviceMe from "../app/api/v1/devices/me/route";
import * as devices from "../app/api/v1/devices/route";
import * as login from "../app/api/v1/auth/login/route";
import * as logout from "../app/api/v1/auth/logout/route";
import * as me from "../app/api/v1/auth/me/route";
import * as pinLogin from "../app/api/v1/auth/pin-login/route";
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

describe("POS device activation and PIN login", () => {
  it("activates a device once with its code", async () => {
    const device = await db.device.create({ data: { branchId: t.branchA1.id, name: "Counter 2", activationCode: "NEWCODE123" } });
    const first = await call(activate.POST, { method: "POST", body: { activationCode: "newcode123" } });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ device: { id: device.id, branchId: t.branchA1.id } });
    expect(String(first.body.deviceToken)).toMatch(new RegExp(`^${device.id}\\.`));

    const reused = await call(activate.POST, { method: "POST", body: { activationCode: "NEWCODE123" } });
    expect(reused.status).toBe(409);
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

  it("refuses PIN login without an activated device", async () => {
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

  it("issues a new activation code on reset and invalidates the old device token", async () => {
    const ownerToken = await webSession(t.ownerA.id);
    const response = await call(devices.PATCH, { method: "PATCH", token: ownerToken, body: { deviceId: t.deviceA1.id, resetActivation: true } });
    expect(response.status).toBe(200);
    expect((response.body.device as { activationCode: string }).activationCode).not.toBe(t.deviceA1.activationCode);
    expect(response.body.device).not.toHaveProperty("secretHash");
    expect((await call(deviceMe.GET, { deviceToken: t.deviceA1.token })).status).toBe(401);
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
