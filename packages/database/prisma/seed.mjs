import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { importMasterProducts, readMasterCsv } from "../src/master-import.ts";

const derive = promisify(scrypt);
const db = new PrismaClient();

async function hash(secret) {
  const salt = randomBytes(16);
  const key = await derive(secret, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

const credentialHash = await hash(process.env.SEED_OWNER_CREDENTIAL || "change-me-now");
const adminCredentialHash = await hash(process.env.SEED_ADMIN_CREDENTIAL || "change-me-now");
const ownerPinHash = await hash(process.env.SEED_OWNER_PIN || "1111");
const cashierPinHash = await hash(process.env.SEED_CASHIER_PIN || "1234");

// A fixed shop code, so the demo counter is always PHRM24-1.
const SHOP_CODE = "PHRM24";
const organisation = await db.organisation.upsert({
  where: { id: "demo-organisation" },
  update: { shopCode: SHOP_CODE },
  create: { id: "demo-organisation", name: "Demo Pharmacy", shopCode: SHOP_CODE }
});

// The demo pharmacy runs on a Pro trial; the plans themselves come from the tenants_billing migration.
const existingSubscription = await db.subscription.findUnique({ where: { organisationId: organisation.id } });
if (!existingSubscription) {
  const subscription = await db.subscription.create({ data: { organisationId: organisation.id, planId: "plan_pro", status: "TRIAL", isTrial: true, paidThrough: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
  await db.subscriptionEvent.create({ data: { subscriptionId: subscription.id, type: "created", toStatus: "TRIAL", reason: "Demo pharmacy" } });
}

const branch = await db.branch.upsert({
  where: { id: "demo-branch" },
  update: {},
  create: { id: "demo-branch", organisationId: organisation.id, name: "Main Branch" }
});

await db.device.upsert({
  where: { id: "demo-device" },
  update: { isActive: true },
  create: { id: "demo-device", branchId: branch.id, name: `${SHOP_CODE}-1`, counterNumber: 1 }
});
// Counters added later keep their numbers but follow the fixed shop code.
for (const device of await db.device.findMany({ where: { branch: { organisationId: organisation.id } } })) {
  const name = `${SHOP_CODE}-${device.counterNumber}`;
  if (device.name !== name) await db.device.update({ where: { id: device.id }, data: { name } });
}

await db.user.upsert({
  where: { login: "owner@demo.local" },
  update: { credentialHash, pinHash: ownerPinHash, branchId: null, isActive: true },
  create: {
    organisationId: organisation.id,
    name: "Demo Owner",
    login: "owner@demo.local",
    credentialHash,
    pinHash: ownerPinHash,
    role: "OWNER"
  }
});

await db.user.upsert({
  where: { login: "cashier@demo.local" },
  update: { pinHash: cashierPinHash, maxDiscountPercent: 5, isActive: true },
  create: { organisationId: organisation.id, branchId: branch.id, name: "Demo Cashier", login: "cashier@demo.local", pinHash: cashierPinHash, maxDiscountPercent: 5, role: "CASHIER" }
});

await db.user.upsert({
  where: { login: "admin@pharmica.local" },
  update: { credentialHash: adminCredentialHash, isActive: true },
  create: { name: "Pharmica Admin", login: "admin@pharmica.local", credentialHash: adminCredentialHash, role: "SUPER_ADMIN" }
});

// Master list: demo fixture prices for well-known brands, not DRAP data.
const masterCsv = readFileSync(new URL("./data/master-products.demo.csv", import.meta.url), "utf8");
const { rows, issues } = readMasterCsv(masterCsv);
if (issues.length) throw new Error(`Demo master list has problems: ${JSON.stringify(issues)}`);
const imported = await importMasterProducts(db, rows, { source: "MANUAL", reference: "Demo fixture (not DRAP data)" });
console.log(`Master list: ${imported.created} created, ${imported.updated} updated, ${imported.priceChanges} price changes, ${imported.unchanged} unchanged.`);

const DAY = 24 * 60 * 60 * 1000;

/** Sets a demo batch's stock and records the change in the stock ledger, so stock always equals its ledger. */
async function setDemoStock(product, batchNo, values) {
  const existing = await db.batch.findUnique({ where: { productId_batchNo: { productId: product.id, batchNo } } });
  const batch = existing
    ? await db.batch.update({ where: { id: existing.id }, data: values })
    : await db.batch.create({ data: { productId: product.id, batchNo, ...values } });
  const { _sum } = await db.stockMovement.aggregate({ where: { batchId: batch.id }, _sum: { quantity: true } });
  const difference = batch.quantity - (_sum.quantity ?? 0);
  if (difference !== 0) {
    await db.stockMovement.create({ data: { branchId: product.branchId, productId: product.id, batchId: batch.id, type: "OPENING", quantity: difference, reason: "Demo stock (seed)" } });
  }
}
const inDays = (days) => new Date(Date.now() + days * DAY);

// Stock for the demo branch, in packs. `older` adds an earlier batch at its old (lower) price that sells first.
const stock = [
  { name: "Panadol 500mg", packs: 12, older: { packs: 2, price: 250, days: 120 } },
  { name: "Panadol Extra", packs: 10 },
  { name: "Panadol CF", packs: 8 },
  { name: "Calpol Syrup 120mg/5ml", packs: 15 },
  { name: "Augmentin 625mg", packs: 20, older: { packs: 5, price: 640, days: 200 } },
  { name: "Augmentin DS Suspension", packs: 6 },
  { name: "Amoxil 500mg", packs: 10 },
  { name: "Brufen 400mg", packs: 9, older: { packs: 1, price: 300, days: 45 } },
  { name: "Brufen Syrup", packs: 12 },
  { name: "Arinac Forte", packs: 14 },
  { name: "Disprin 300mg", packs: 6 },
  { name: "Flagyl 400mg", packs: 10 },
  { name: "Risek 20mg", packs: 18 },
  { name: "Risek 40mg", packs: 12 },
  { name: "Nexum 40mg", packs: 8 },
  { name: "Novidat 500mg", packs: 10 },
  { name: "Ponstan Forte 500mg", packs: 10 },
  { name: "Norvasc 5mg", packs: 6 },
  { name: "Glucophage 500mg", packs: 12 },
  { name: "Concor 5mg", packs: 5 },
  { name: "Neurobion", packs: 10 },
  { name: "Softin 10mg", packs: 7 },
  { name: "Ascard 75mg", packs: 20 },
  { name: "Azomax 500mg", packs: 8 },
  { name: "Voltral Emulgel", packs: 6 },
  { name: "Peditral Orange", packs: 40 },
  { name: "Hydryllin Syrup", packs: 10, nearExpiryDays: 40 },
  { name: "Mucolator Syrup", packs: 4, expiredDays: -20 },
  { name: "Ventolin Inhaler", packs: 3 },
  { name: "Lantus SoloStar", packs: 1, lowStockThreshold: 3 },
  { name: "Xanax 0.5mg", packs: 3 },
  { name: "Tramal 50mg", packs: 2 }
];

for (const item of stock) {
  const master = await db.masterProduct.findFirst({ where: { name: item.name } });
  if (!master) throw new Error(`Demo stock refers to unknown master product ${item.name}`);
  const product = await db.product.upsert({
    where: { branchId_masterProductId: { branchId: branch.id, masterProductId: master.id } },
    update: { lowStockThreshold: item.lowStockThreshold ?? 2 },
    create: { branchId: branch.id, masterProductId: master.id, name: master.name, generic: master.generic, barcode: master.barcode, lowStockThreshold: item.lowStockThreshold ?? 2 }
  });
  const baseUnitsPerPack = master.unitsPerPack * master.tabletsPerStrip;
  const price = Number(master.officialRetailPrice);
  const batches = [{ batchNo: "DEMO-2026-B", packs: item.packs, price, expiry: item.expiredDays !== undefined ? inDays(item.expiredDays) : inDays(item.nearExpiryDays ?? 540) }];
  if (item.older) batches.push({ batchNo: "DEMO-2025-A", packs: item.older.packs, price: item.older.price, expiry: inDays(item.older.days) });
  for (const batch of batches) {
    const values = { expiryDate: batch.expiry, quantity: batch.packs * baseUnitsPerPack, costPrice: Math.round(batch.price * 0.85 * 100) / 100, retailPrice: batch.price, retailPriceSource: "Demo fixture" };
    await setDemoStock(product, batch.batchNo, values);
  }
}

// Shop-specific items that are not on the medicine master list.
const shopItems = [
  { name: "Moisturising Cream 100ml", category: "COSMETIC", company: "Generic", barcode: "2100000000014", price: 450, packs: 6 },
  { name: "Surgical Gloves (pair)", category: "SURGICAL", company: "Generic", barcode: "2100000000021", price: 60, packs: 50 },
  { name: "Baby Diapers Medium (20)", category: "BABY", company: "Generic", barcode: "2100000000038", price: 1650, packs: 5 },
  { name: "Cotton Bandage 4 inch", category: "SURGICAL", company: "Generic", barcode: "2100000000045", price: 80, packs: 30 }
];
for (const item of shopItems) {
  const product = await db.product.upsert({
    where: { branchId_barcode: { branchId: branch.id, barcode: item.barcode } },
    update: { retailPriceOverride: item.price },
    create: { branchId: branch.id, name: item.name, category: item.category, company: item.company, barcode: item.barcode, unitsPerPack: 1, tabletsPerStrip: 1, retailPriceOverride: item.price, isShopSpecific: true, lowStockThreshold: 2 }
  });
  const values = { expiryDate: inDays(1095), quantity: item.packs, costPrice: Math.round(item.price * 0.7), retailPrice: item.price, retailPriceSource: "Demo fixture" };
  await setDemoStock(product, "DEMO-SHOP", values);
}

// Retire the stock of the earlier two-product seed, keeping its history.
for (const product of await db.product.findMany({ where: { branchId: branch.id, batches: { some: { batchNo: "DEMO-001" } } } })) {
  await setDemoStock(product, "DEMO-001", { quantity: 0 });
}

console.log("Seeded owner@demo.local, cashier@demo.local, admin@pharmica.local, and the counter PHRM24-1 (link it on the POS by entering the counter name).");
await db.$disconnect();
