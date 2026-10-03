import { db } from "@pharmica/database/client";
import { newDeviceSecret } from "../src/auth/authorization";
import { hashCredential } from "../src/auth/credentials";
import { createSession } from "../src/auth/session";

/** Empties every table. Refuses to touch anything but a `_test` database. */
export async function resetDatabase(): Promise<void> {
  const [{ current_database: name }] = await db.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
  if (!name.endsWith("_test")) throw new Error(`Refusing to reset non-test database "${name}"`);
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((table) => `"${table.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

/** Creates a batch with its opening ledger movement, as real stock always has. */
export async function stockBatch(productId: string, data: { batchNo: string; expiryDate: Date; quantity: number; retailPrice: number; costPrice?: number }) {
  const product = await db.product.findUniqueOrThrow({ where: { id: productId } });
  const batch = await db.batch.create({ data: { productId, ...data } });
  if (data.quantity) await db.stockMovement.create({ data: { branchId: product.branchId, productId, batchId: batch.id, type: "OPENING", quantity: data.quantity, reason: "Test stock" } });
  return batch;
}

export const PASSWORD = "correct-horse-battery";
export const PIN = "4321";

async function makeDevice(branchId: string, name: string) {
  const { secret, secretHash } = newDeviceSecret();
  const device = await db.device.create({ data: { branchId, name, activationCode: `${name}-CODE`.toUpperCase(), secretHash, activatedAt: new Date() } });
  return { ...device, token: `${device.id}.${secret}` };
}

/**
 * Two tenants: org A with branches A1 and A2, org B with branch B1.
 * Each branch has a device; A1 has a stocked product.
 */
export async function seedTenants() {
  const credentialHash = await hashCredential(PASSWORD);
  const pinHash = await hashCredential(PIN);

  const orgA = await db.organisation.create({ data: { name: "Org A" } });
  const orgB = await db.organisation.create({ data: { name: "Org B" } });
  const branchA1 = await db.branch.create({ data: { organisationId: orgA.id, name: "A1" } });
  const branchA2 = await db.branch.create({ data: { organisationId: orgA.id, name: "A2" } });
  const branchB1 = await db.branch.create({ data: { organisationId: orgB.id, name: "B1" } });

  const user = (data: { login: string; role: "OWNER" | "CASHIER" | "SUPER_ADMIN"; organisationId?: string; branchId?: string }) =>
    db.user.create({ data: { name: data.login, credentialHash, pinHash, ...data } });

  const ownerA = await user({ login: "owner-a", role: "OWNER", organisationId: orgA.id });
  const cashierA1 = await user({ login: "cashier-a1", role: "CASHIER", organisationId: orgA.id, branchId: branchA1.id });
  const cashierA2 = await user({ login: "cashier-a2", role: "CASHIER", organisationId: orgA.id, branchId: branchA2.id });
  const ownerB = await user({ login: "owner-b", role: "OWNER", organisationId: orgB.id });
  const admin = await user({ login: "admin", role: "SUPER_ADMIN" });

  const deviceA1 = await makeDevice(branchA1.id, "pos-a1");
  const deviceB1 = await makeDevice(branchB1.id, "pos-b1");

  const master = await db.masterProduct.create({ data: { name: "Panadol 500mg", generic: "Paracetamol", unitsPerPack: 10, tabletsPerStrip: 10, officialRetailPrice: 100 } });
  const productA1 = await db.product.create({ data: { branchId: branchA1.id, masterProductId: master.id, name: master.name } });
  await stockBatch(productA1.id, { batchNo: "B-1", expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), quantity: 1000, costPrice: 80, retailPrice: 100 });

  return { orgA, orgB, branchA1, branchA2, branchB1, ownerA, cashierA1, cashierA2, ownerB, admin, deviceA1, deviceB1, productA1 };
}

export async function webSession(userId: string): Promise<string> {
  return (await createSession(userId)).token;
}

export async function deviceSession(userId: string, deviceId: string): Promise<string> {
  return (await createSession(userId, deviceId)).token;
}

// Dynamic routes in this API all name their segment `id`.
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Response | Promise<Response>;

/** Invokes a route handler the way Next.js would. */
export async function call(
  handler: Handler,
  options: { method?: string; path?: string; token?: string; deviceToken?: string; body?: unknown; params?: { id: string }; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: Record<string, unknown> & { error?: { code: string } }; headers: Headers }> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.deviceToken) headers.set("x-device-token", options.deviceToken);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`http://localhost:4000${options.path ?? "/"}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const response = await handler(request, { params: Promise.resolve(options.params ?? { id: "" }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}
