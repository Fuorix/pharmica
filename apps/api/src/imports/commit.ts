import { db, type Prisma } from "@pharmica/database/client";
import { normaliseName, packStructure, unitSize } from "@pharmica/domain";
import type { StockData } from "./check";

type Tx = Prisma.TransactionClient;
type JobRow = Prisma.ImportRowGetPayload<object>;
type Job = Prisma.ImportJobGetPayload<object>;

export class ImportCommitError extends Error {}

/** Midday Pakistan time on a calendar day, so a back-dated balance lands on that day in every report. */
const middayPk = (day: string) => new Date(`${day}T12:00:00+05:00`);

/**
 * Commits an import in one transaction: every ready row is written, or (if anything fails) none is. The job is locked
 * first, so two people pressing commit at once import it once. Rows that turn out to exist already (a batch on the
 * shelf, a customer with the same mobile) are skipped, never doubled.
 */
export async function commitImport(jobId: string, actorId: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ImportJob" WHERE id = ${jobId} FOR UPDATE`;
    const job = await tx.importJob.findUnique({ where: { id: jobId } });
    if (!job) throw new ImportCommitError("Import not found");
    if (job.status !== "REVIEW") throw new ImportCommitError(job.status === "COMMITTED" ? "This import was already committed" : "Check the column matching before committing");
    const waiting = await tx.importRow.count({ where: { jobId, status: "NEEDS_REVIEW" } });
    if (waiting) throw new ImportCommitError(`${waiting} row${waiting === 1 ? " needs" : "s need"} a decision first`);
    const rows = await tx.importRow.findMany({ where: { jobId, status: "READY" }, orderBy: { line: "asc" } });

    const summary = job.kind === "STOCK" ? await commitStock(tx, job, rows, actorId)
      : job.kind === "CUSTOMERS" ? await commitCustomers(tx, job, rows, actorId, now)
      : await commitSuppliers(tx, job, rows, actorId);

    await tx.importJob.update({ where: { id: jobId }, data: { status: "COMMITTED", committedAt: now, committedById: actorId, lastError: null, summary } });
    // The first import moves onboarding on: the data migration is now under way.
    const organisation = await tx.organisation.findUniqueOrThrow({ where: { id: job.organisationId } });
    const onboarding = (organisation.onboarding && typeof organisation.onboarding === "object" && !Array.isArray(organisation.onboarding) ? organisation.onboarding : {}) as Record<string, unknown>;
    if (!onboarding.migrationStatus || onboarding.migrationStatus === "NOT_STARTED") await tx.organisation.update({ where: { id: organisation.id }, data: { onboarding: { ...onboarding, migrationStatus: "IN_PROGRESS" } } });
    await tx.auditLog.create({ data: { organisationId: job.organisationId, branchId: job.branchId, userId: actorId, action: "import.committed", entityType: "import", entityId: jobId, metadata: { kind: job.kind, fileName: job.fileName, ...summary } } });
    return summary;
  }, { timeout: 300_000, maxWait: 20_000 });
}

async function settle(tx: Tx, row: JobRow, result: Record<string, unknown> | null, skipped?: string) {
  await tx.importRow.update({ where: { id: row.id }, data: skipped ? { status: "SKIPPED", problems: [...row.problems, skipped] } : { status: "COMMITTED", result: result as Prisma.InputJsonValue } });
}

async function commitStock(tx: Tx, job: Job, rows: JobRow[], actorId: string) {
  const summary = { itemsCreated: 0, itemsLinked: 0, batches: 0, units: 0, skipped: 0 };
  // Rows naming the same new item (same name and packing, or the same barcode) become one shop item.
  const newItems = new Map<string, string>();
  for (const row of rows) {
    const data = row.data as unknown as StockData;
    let productId = row.productId;
    if (row.action === "MASTER") {
      const master = await tx.masterProduct.findUniqueOrThrow({ where: { id: row.masterProductId! } });
      const linked = await tx.product.findUnique({ where: { branchId_masterProductId: { branchId: job.branchId, masterProductId: master.id } } });
      if (linked) productId = linked.id;
      else {
        const created = await tx.product.create({ data: { branchId: job.branchId, masterProductId: master.id, name: master.name, generic: master.generic, barcode: master.barcode && !await tx.product.findFirst({ where: { branchId: job.branchId, barcode: master.barcode } }) ? master.barcode : null, rackLocation: data.rack } });
        productId = created.id;
        summary.itemsLinked++;
      }
    } else if (row.action === "NEW") {
      const key = data.barcode ? `barcode:${data.barcode}` : `${normaliseName(data.name).join(" ")}|${data.unitsPerPack ?? 1}x${data.tabletsPerStrip ?? 1}`;
      productId = newItems.get(key) ?? null;
      if (!productId) {
        const created = await tx.product.create({ data: { branchId: job.branchId, name: data.name, company: data.company, generic: data.generic, barcode: data.barcode, unitsPerPack: data.unitsPerPack ?? 1, tabletsPerStrip: data.tabletsPerStrip ?? 1, isShopSpecific: true, rackLocation: data.rack } });
        productId = created.id;
        newItems.set(key, productId);
        summary.itemsCreated++;
      }
    }
    if (!productId) throw new ImportCommitError(`Line ${row.line}: no item chosen`);

    const product = await tx.product.findUniqueOrThrow({ where: { id: productId }, include: { masterProduct: true } });
    if (data.rack && !product.rackLocation) await tx.product.update({ where: { id: product.id }, data: { rackLocation: data.rack } });
    if (!(data.packs > 0 || data.units > 0)) { await settle(tx, row, { productId }); continue; }

    const perPack = unitSize("pack", packStructure(product));
    const quantity = Math.round(data.packs * perPack + data.units);
    const batchNo = data.batchNo ?? `OPEN-${data.expiry!.slice(0, 7)}`;
    if (await tx.batch.findUnique({ where: { productId_batchNo: { productId, batchNo } } })) {
      summary.skipped++;
      await settle(tx, row, null, `Batch ${batchNo} of ${product.name} is already in stock (or appears twice in the file), so it was not added again`);
      continue;
    }
    const retailPrice = data.retailPrice ?? (product.retailPriceOverride != null ? Number(product.retailPriceOverride) : product.masterProduct?.officialRetailPrice != null ? Number(product.masterProduct.officialRetailPrice) : null);
    if (retailPrice == null) throw new ImportCommitError(`Line ${row.line}: ${product.name} needs a retail price`);
    const batch = await tx.batch.create({ data: { productId, batchNo, expiryDate: middayPk(data.expiry!), quantity, costPrice: data.costPrice, retailPrice, retailPriceSource: "IMPORT" } });
    // Opening stock always enters through the ledger, so stock keeps equalling its movements.
    await tx.stockMovement.create({ data: { branchId: job.branchId, productId, batchId: batch.id, userId: actorId, type: "OPENING", quantity, reason: `Opening stock imported from ${job.fileName}`, referenceId: job.id } });
    summary.batches++;
    summary.units += quantity;
    await settle(tx, row, { productId, batchId: batch.id, quantity });
  }
  return summary;
}

async function commitCustomers(tx: Tx, job: Job, rows: JobRow[], actorId: string, now: Date) {
  const summary = { customers: 0, withBalance: 0, owedToShop: 0, advances: 0, skipped: 0 };
  for (const row of rows) {
    const data = row.data as { name: string; phone: string | null; balance: number; creditLimit: number | null; since: string | null };
    const existing = await tx.customer.findFirst({ where: { branchId: job.branchId, ...(data.phone ? { phone: data.phone } : { name: { equals: data.name, mode: "insensitive" } }) } });
    if (existing) { summary.skipped++; await settle(tx, row, null, `Already in Pharmica as ${existing.name}, so it was not added again`); continue; }
    const customer = await tx.customer.create({ data: { branchId: job.branchId, name: data.name, phone: data.phone, creditLimit: data.creditLimit } });
    summary.customers++;
    if (data.balance) {
      await tx.customerLedgerEntry.create({ data: { branchId: job.branchId, customerId: customer.id, userId: actorId, type: "ADJUSTMENT", amount: data.balance, note: `Opening balance imported from ${job.fileName}`, createdAt: data.since ? middayPk(data.since) : now } });
      summary.withBalance++;
      if (data.balance > 0) summary.owedToShop = Math.round((summary.owedToShop + data.balance) * 100) / 100;
      else summary.advances = Math.round((summary.advances - data.balance) * 100) / 100;
    }
    await settle(tx, row, { customerId: customer.id });
  }
  return summary;
}

async function commitSuppliers(tx: Tx, job: Job, rows: JobRow[], actorId: string) {
  const summary = { suppliers: 0, withBalance: 0, owedByShop: 0, skipped: 0 };
  for (const row of rows) {
    const data = row.data as { name: string; phone: string | null; address: string | null; balance: number };
    const existing = await tx.supplier.findFirst({ where: { branchId: job.branchId, name: { equals: data.name, mode: "insensitive" } } });
    if (existing) { summary.skipped++; await settle(tx, row, null, "Already in Pharmica, so it was not added again"); continue; }
    const supplier = await tx.supplier.create({ data: { branchId: job.branchId, name: data.name, phone: data.phone, address: data.address } });
    summary.suppliers++;
    if (data.balance) {
      await tx.supplierLedgerEntry.create({ data: { branchId: job.branchId, supplierId: supplier.id, userId: actorId, type: "ADJUSTMENT", amount: data.balance, reference: "Opening balance", note: `Imported from ${job.fileName}` } });
      summary.withBalance++;
      summary.owedByShop = Math.round((summary.owedByShop + data.balance) * 100) / 100;
    }
    await settle(tx, row, { supplierId: supplier.id });
  }
  return summary;
}
