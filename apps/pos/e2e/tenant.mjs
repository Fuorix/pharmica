// Creates or removes a throwaway tenant in the development database for the POS end-to-end test.
// Run with the database package as the working directory so Prisma finds its environment:
//   node ../../apps/pos/e2e/tenant.mjs setup|cleanup
import { createRequire } from "node:module";
import { randomBytes, scryptSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const require = createRequire(`${process.cwd()}/package.json`);
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
const ORG = "e2e-pos-org";
const BRANCH = "e2e-pos-branch";
export const ACTIVATION_CODE = "E2EPOSCODE01";
const hash = (secret) => { const salt = randomBytes(16); return `scrypt$${salt.toString("hex")}$${scryptSync(secret, salt, 64).toString("hex")}`; };

async function cleanup() {
  const where = { branch: { organisationId: ORG } };
  // The narcotics register refuses deletes; test cleanup unlocks it for its own transaction only.
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL pharmica.allow_register_purge = 'on'"),
    db.controlledDrugRecord.deleteMany({ where })
  ]);
  await db.priceChangeReport.deleteMany({ where });
  await db.purchaseLine.deleteMany({ where: { purchase: where } });
  await db.supplierLedgerEntry.deleteMany({ where });
  await db.purchase.deleteMany({ where });
  await db.supplier.deleteMany({ where });
  await db.saleReturnLine.deleteMany({ where: { saleReturn: { sale: where } } });
  await db.saleReturn.deleteMany({ where: { sale: where } });
  await db.stockMovement.deleteMany({ where });
  await db.customerLedgerEntry.deleteMany({ where });
  await db.saleLine.deleteMany({ where: { sale: where } });
  await db.sale.deleteMany({ where });
  await db.shift.deleteMany({ where });
  await db.batch.deleteMany({ where: { product: where } });
  await db.product.deleteMany({ where });
  await db.customer.deleteMany({ where });
  await db.syncOperation.deleteMany({ where: { device: where } });
  await db.session.deleteMany({ where: { user: { organisationId: ORG } } });
  await db.auditLog.deleteMany({ where: { OR: [{ organisationId: ORG }, { branchId: BRANCH }, { entityId: { startsWith: "login:e2e-pos" } }] } });
  await db.device.deleteMany({ where });
  await db.expense.deleteMany({ where });
  await db.user.deleteMany({ where: { organisationId: ORG } });
  await db.branch.deleteMany({ where: { organisationId: ORG } });
  await db.organisation.deleteMany({ where: { id: ORG } });
}

async function setup() {
  await cleanup();
  await db.organisation.create({ data: { id: ORG, name: "E2E Pharmacy" } });
  await db.branch.create({ data: { id: BRANCH, organisationId: ORG, name: "E2E Branch" } });
  await db.user.create({ data: { organisationId: ORG, name: "E2E Owner", login: "e2e-pos-owner@test.local", credentialHash: hash("e2e-password-123"), pinHash: hash("1111"), role: "OWNER" } });
  await db.user.create({ data: { organisationId: ORG, branchId: BRANCH, name: "E2E Cashier", login: "e2e-pos-cashier", pinHash: hash("1234"), role: "CASHIER", maxDiscountPercent: 5 } });
  await db.device.create({ data: { branchId: BRANCH, name: "E2E Counter", activationCode: ACTIVATION_CODE } });
  await db.device.create({ data: { branchId: BRANCH, name: "E2E Counter 2", activationCode: "E2EPOSCODE02" } });
  await db.device.create({ data: { branchId: BRANCH, name: "E2E Counter 3", activationCode: "E2EPOSCODE03" } });
  // A master-list medicine this branch does not stock yet, for the receiving test.
  const brufen = await db.masterProduct.findFirstOrThrow({ where: { name: "Brufen 400mg" } });
  writeFileSync(new URL("./.tenant.json", import.meta.url), JSON.stringify({ receive: { barcode: brufen.barcode, unitsPerPack: brufen.unitsPerPack, tabletsPerStrip: brufen.tabletsPerStrip, officialRetailPrice: Number(brufen.officialRetailPrice) } }));
  const master = await db.masterProduct.findFirstOrThrow({ where: { name: "Panadol 500mg" } });
  const product = await db.product.create({ data: { branchId: BRANCH, masterProductId: master.id, name: master.name, generic: master.generic, barcode: master.barcode } });
  const perPack = master.unitsPerPack * master.tabletsPerStrip;
  const day = 86_400_000;
  // Stock used only by the credit test, so the scenarios do not share batches.
  const arinacMaster = await db.masterProduct.findFirstOrThrow({ where: { name: "Arinac" } });
  const arinac = await db.product.create({ data: { branchId: BRANCH, masterProductId: arinacMaster.id, name: arinacMaster.name, generic: arinacMaster.generic, barcode: arinacMaster.barcode } });
  const arinacBatch = await db.batch.create({ data: { productId: arinac.id, batchNo: "E2E-AR", quantity: 5 * arinacMaster.unitsPerPack * arinacMaster.tabletsPerStrip, retailPrice: 310, expiryDate: new Date(Date.now() + 400 * 86_400_000) } });
  await db.stockMovement.create({ data: { branchId: BRANCH, productId: arinac.id, batchId: arinacBatch.id, type: "OPENING", quantity: arinacBatch.quantity, reason: "E2E opening stock" } });

  // A controlled (scheduled) drug for the narcotics register test.
  const xanaxMaster = await db.masterProduct.findFirstOrThrow({ where: { name: "Xanax 0.5mg" } });
  const xanax = await db.product.create({ data: { branchId: BRANCH, masterProductId: xanaxMaster.id, name: xanaxMaster.name, generic: xanaxMaster.generic, barcode: xanaxMaster.barcode } });
  const xanaxBatch = await db.batch.create({ data: { productId: xanax.id, batchNo: "E2E-XN", quantity: 5 * xanaxMaster.unitsPerPack * xanaxMaster.tabletsPerStrip, retailPrice: Number(xanaxMaster.officialRetailPrice), expiryDate: new Date(Date.now() + 400 * 86_400_000) } });
  await db.stockMovement.create({ data: { branchId: BRANCH, productId: xanax.id, batchId: xanaxBatch.id, type: "OPENING", quantity: xanaxBatch.quantity, reason: "E2E opening stock" } });

  for (const batch of [{ batchNo: "E2E-OLD", packs: 2, retailPrice: 250, days: 90 }, { batchNo: "E2E-NEW", packs: 5, retailPrice: 270, days: 500 }]) {
    const created = await db.batch.create({ data: { productId: product.id, batchNo: batch.batchNo, quantity: batch.packs * perPack, retailPrice: batch.retailPrice, expiryDate: new Date(Date.now() + batch.days * day) } });
    // Stock always starts with a ledger entry, so stock equals its ledger.
    await db.stockMovement.create({ data: { branchId: BRANCH, productId: product.id, batchId: created.id, type: "OPENING", quantity: created.quantity, reason: "E2E opening stock" } });
  }
}

try {
  if (process.argv[2] === "cleanup") await cleanup();
  else await setup();
} finally {
  await db.$disconnect();
}
