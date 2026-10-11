import type { DuplicateCandidate, PriceListRowItem, PriceListUploadSummary, ShopPriceReportGroup } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { resolveCurrentPrice } from "../catalogue/master-price";

type Tx = Prisma.TransactionClient;

/**
 * Records an official price and keeps the stored current price in step. History is append-only; a future date
 * schedules the change. Every price that reaches shops goes through here after a person reviewed it.
 */
export async function recordMasterPrice(tx: Tx, input: { masterProductId: string; price: number; effectiveFrom: Date; source: string; reference: string | null; actorId: string }, now = new Date()) {
  const entry = await tx.masterPriceHistory.create({ data: { masterProductId: input.masterProductId, price: input.price, effectiveFrom: input.effectiveFrom, source: input.source, reference: input.reference, recordedById: input.actorId } });
  const history = (await tx.masterPriceHistory.findMany({ where: { masterProductId: input.masterProductId } })).map((row) => ({ ...row, price: Number(row.price) }));
  // A scheduled price leaves the current one alone until it starts, even for a medicine with no earlier history.
  const current = resolveCurrentPrice(history, now);
  if (current) await tx.masterProduct.update({ where: { id: input.masterProductId }, data: { officialRetailPrice: current.price } });
  return entry;
}

async function currentPrices(masterIds: string[], now: Date): Promise<Map<string, number | null>> {
  const history = await db.masterPriceHistory.findMany({ where: { masterProductId: { in: masterIds } } });
  const byMaster = new Map<string, Array<{ price: number; effectiveFrom: Date; createdAt: Date }>>();
  for (const row of history) byMaster.set(row.masterProductId, [...(byMaster.get(row.masterProductId) ?? []), { price: Number(row.price), effectiveFrom: row.effectiveFrom, createdAt: row.createdAt }]);
  return new Map(masterIds.map((id) => [id, resolveCurrentPrice(byMaster.get(id) ?? [], now)?.price ?? null]));
}

// ---------- shop-reported price changes ----------

const groupKey = (masterProductId: string, price: number) => `${masterProductId}:${price.toFixed(2)}`;

/**
 * Pending price reports from shops (a received batch printed with a price different from the master list), grouped
 * by medicine and reported price, so one review settles every shop that saw the same new price.
 */
export async function shopReportGroups(now = new Date()): Promise<ShopPriceReportGroup[]> {
  const reports = await db.priceChangeReport.findMany({
    where: { status: "PENDING", product: { masterProductId: { not: null }, masterProduct: { mergedIntoId: null } } },
    include: { product: { include: { masterProduct: true } }, branch: { include: { organisation: { select: { name: true } } } }, batch: { select: { batchNo: true } }, purchase: { select: { invoiceNumber: true, supplier: { select: { name: true } } } } },
    orderBy: { createdAt: "asc" }
  });
  const groups = new Map<string, typeof reports>();
  for (const report of reports) {
    const key = groupKey(report.product.masterProductId!, Number(report.newPrice));
    groups.set(key, [...(groups.get(key) ?? []), report]);
  }
  const official = await currentPrices([...new Set(reports.map((report) => report.product.masterProductId!))], now);
  return [...groups.entries()].map(([key, items]) => {
    const master = items[0].product.masterProduct!;
    return {
      key, masterProductId: master.id, name: master.name, company: master.company, officialPrice: official.get(master.id) ?? null,
      reportedPrice: Number(items[0].newPrice), shops: new Set(items.map((item) => item.branch.organisationId)).size, reports: items.length,
      firstReportedAt: items[0].createdAt.toISOString(), lastReportedAt: items.at(-1)!.createdAt.toISOString(),
      examples: items.slice(-5).reverse().map((item) => ({ branchName: item.branch.name, organisationName: item.branch.organisation.name, batchNo: item.batch?.batchNo ?? null, supplier: item.purchase?.supplier.name ?? null, invoiceNumber: item.purchase?.invoiceNumber ?? null }))
    };
  }).sort((a, b) => b.shops - a.shops || b.lastReportedAt.localeCompare(a.lastReportedAt));
}

/** Publishes the reported price to every shop, or dismisses the reports. Either way each report records who decided. */
export async function settleShopReports(input: { masterProductId: string; reportedPrice: number; action: "publish" | "dismiss"; note?: string; effectiveFrom?: Date; actorId: string }, now = new Date()) {
  return db.$transaction(async (tx) => {
    const reports = await tx.priceChangeReport.findMany({ where: { status: "PENDING", product: { masterProductId: input.masterProductId } } });
    const matching = reports.filter((report) => Math.abs(Number(report.newPrice) - input.reportedPrice) < 0.005);
    if (!matching.length) return null;
    const shops = new Set((await tx.branch.findMany({ where: { id: { in: matching.map((report) => report.branchId) } }, select: { organisationId: true } })).map((branch) => branch.organisationId)).size;
    let entryId: string | null = null;
    if (input.action === "publish") {
      const entry = await recordMasterPrice(tx, { masterProductId: input.masterProductId, price: input.reportedPrice, effectiveFrom: input.effectiveFrom ?? now, source: "SHOP_REPORT", reference: `Reported by ${shops} shop${shops === 1 ? "" : "s"}${input.note ? `: ${input.note}` : ""}`, actorId: input.actorId }, now);
      entryId = entry.id;
    }
    await tx.priceChangeReport.updateMany({ where: { id: { in: matching.map((report) => report.id) } }, data: { status: input.action === "publish" ? "PUBLISHED" : "DISMISSED", reviewedById: input.actorId, reviewedAt: now, reviewNote: input.note ?? null } });
    await tx.auditLog.create({ data: { userId: input.actorId, action: input.action === "publish" ? "catalogue.shop_reports_published" : "catalogue.shop_reports_dismissed", entityType: "master_product", entityId: input.masterProductId, metadata: { price: input.reportedPrice, reports: matching.length, shops, note: input.note ?? null, priceEntryId: entryId } } });
    return { reports: matching.length, shops, priceEntryId: entryId };
  });
}

// ---------- price-list uploads ----------

const MAX_ROWS = 20_000;
const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Splits CSV text into rows, honouring quoted cells with commas, quotes, and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index++;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

const COLUMN_NAMES = {
  name: ["name", "product", "product name", "brand", "item", "medicine"],
  barcode: ["barcode", "gtin", "ean"],
  registrationNo: ["registration", "registration no", "reg no", "drap", "drap registration", "drap registration no"],
  price: ["price", "retail price", "mrp", "new price", "trade retail price", "rp"]
} as const;

/**
 * Reads an uploaded price list and matches each row to the master list by barcode, then DRAP registration number,
 * then exact name. Nothing is published here: rows wait for review.
 */
export async function createPriceListUpload(input: { source: string; reference: string; effectiveFrom: Date; fileName: string | null; csv: string; actorId: string }, now = new Date()) {
  const rows = parseCsv(input.csv);
  if (rows.length < 2) return { error: "The file needs a header row and at least one price" } as const;
  const header = rows[0].map(normalise);
  const column = (names: readonly string[]) => header.findIndex((cell) => names.includes(cell));
  const columns = { name: column(COLUMN_NAMES.name), barcode: column(COLUMN_NAMES.barcode), registrationNo: column(COLUMN_NAMES.registrationNo), price: column(COLUMN_NAMES.price) };
  if (columns.price < 0 || (columns.name < 0 && columns.barcode < 0 && columns.registrationNo < 0)) return { error: "The header needs a price column and a name, barcode, or registration column" } as const;
  const body = rows.slice(1);
  if (body.length > MAX_ROWS) return { error: `Upload at most ${MAX_ROWS} rows at a time` } as const;

  const cell = (row: string[], index: number) => index < 0 ? "" : (row[index] ?? "").trim();
  const parsed = body.map((row, index) => {
    const priceText = cell(row, columns.price).replace(/[,\s]|^(pkr|rs\.?)/gi, "");
    const price = priceText ? Number(priceText) : NaN;
    return { line: index + 2, name: cell(row, columns.name), barcode: cell(row, columns.barcode) || null, registrationNo: cell(row, columns.registrationNo) || null, price: Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null };
  });

  const masters = await db.masterProduct.findMany({
    where: { mergedIntoId: null, OR: [
      { barcode: { in: parsed.map((row) => row.barcode).filter((value): value is string => !!value) } },
      { drapRegistrationNo: { in: parsed.map((row) => row.registrationNo).filter((value): value is string => !!value) } },
      { name: { in: parsed.map((row) => row.name).filter(Boolean), mode: "insensitive" } }
    ] },
    select: { id: true, name: true, barcode: true, drapRegistrationNo: true }
  });
  const byBarcode = new Map(masters.filter((master) => master.barcode).map((master) => [master.barcode!, master]));
  const byRegistration = new Map(masters.filter((master) => master.drapRegistrationNo).map((master) => [master.drapRegistrationNo!, master]));
  const byName = new Map<string, typeof masters>();
  for (const master of masters) byName.set(normalise(master.name), [...(byName.get(normalise(master.name)) ?? []), master]);
  const prices = await currentPrices(masters.map((master) => master.id), now);

  const matched = parsed.map((row) => {
    if (row.price === null) return { ...row, masterProductId: null, currentPrice: null, match: "INVALID" as const, problem: "No valid price" };
    const named = row.name ? byName.get(normalise(row.name)) ?? [] : [];
    const master = (row.barcode && byBarcode.get(row.barcode)) || (row.registrationNo && byRegistration.get(row.registrationNo)) || (named.length === 1 ? named[0] : null);
    if (!master) return { ...row, masterProductId: null, currentPrice: null, match: named.length > 1 ? "AMBIGUOUS" as const : "NOT_FOUND" as const, problem: named.length > 1 ? `${named.length} master entries have this name` : "Not on the master list" };
    const current = prices.get(master.id) ?? null;
    return { ...row, masterProductId: master.id, currentPrice: current, match: current !== null && Math.abs(current - row.price) < 0.005 ? "UNCHANGED" as const : "MATCHED" as const, problem: null };
  });

  const upload = await db.priceListUpload.create({
    data: {
      source: input.source, reference: input.reference, fileName: input.fileName, effectiveFrom: input.effectiveFrom, uploadedById: input.actorId,
      rows: { create: matched.map((row) => ({ line: row.line, name: row.name || row.barcode || row.registrationNo || "", barcode: row.barcode, registrationNo: row.registrationNo, price: row.price, masterProductId: row.masterProductId, currentPrice: row.currentPrice, match: row.match, approved: row.match === "MATCHED", problem: row.problem })) }
    }
  });
  await db.auditLog.create({ data: { userId: input.actorId, action: "catalogue.price_list_uploaded", entityType: "price_list", entityId: upload.id, metadata: { source: input.source, reference: input.reference, rows: matched.length } } });
  return { upload };
}

export async function uploadSummaries(where: Prisma.PriceListUploadWhereInput = {}): Promise<PriceListUploadSummary[]> {
  const uploads = await db.priceListUpload.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 });
  const counts = await db.priceListRow.groupBy({ by: ["uploadId", "match", "approved"], where: { uploadId: { in: uploads.map((upload) => upload.id) } }, _count: { _all: true } });
  const people = new Map((await db.user.findMany({ where: { id: { in: uploads.flatMap((upload) => [upload.uploadedById, upload.reviewedById].filter((id): id is string => !!id)) } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]));
  return uploads.map((upload) => {
    const mine = counts.filter((row) => row.uploadId === upload.id);
    const sum = (filter: (row: typeof mine[number]) => boolean) => mine.filter(filter).reduce((total, row) => total + row._count._all, 0);
    return {
      id: upload.id, source: upload.source, reference: upload.reference, fileName: upload.fileName, effectiveFrom: upload.effectiveFrom.toISOString(), status: upload.status,
      uploadedBy: people.get(upload.uploadedById) ?? "Unknown", reviewedBy: upload.reviewedById ? people.get(upload.reviewedById) ?? null : null, reviewedAt: upload.reviewedAt?.toISOString() ?? null, createdAt: upload.createdAt.toISOString(),
      counts: { rows: sum(() => true), matched: sum((row) => row.match === "MATCHED"), unchanged: sum((row) => row.match === "UNCHANGED"), notFound: sum((row) => row.match === "NOT_FOUND"), ambiguous: sum((row) => row.match === "AMBIGUOUS"), invalid: sum((row) => row.match === "INVALID"), approved: sum((row) => row.approved && row.match === "MATCHED") }
    };
  });
}

export async function uploadRows(uploadId: string): Promise<PriceListRowItem[]> {
  const rows = await db.priceListRow.findMany({ where: { uploadId }, orderBy: { line: "asc" } });
  const names = new Map((await db.masterProduct.findMany({ where: { id: { in: rows.map((row) => row.masterProductId).filter((id): id is string => !!id) } }, select: { id: true, name: true } })).map((master) => [master.id, master.name]));
  return rows.map((row) => ({
    id: row.id, line: row.line, name: row.name, barcode: row.barcode, registrationNo: row.registrationNo, price: row.price == null ? null : Number(row.price),
    masterProductId: row.masterProductId, masterName: row.masterProductId ? names.get(row.masterProductId) ?? null : null, currentPrice: row.currentPrice == null ? null : Number(row.currentPrice),
    match: row.match, approved: row.approved, problem: row.problem
  }));
}

/** A reviewer approves or skips a row, or matches it to a master entry by hand. */
export async function reviewRow(input: { rowId: string; approved?: boolean; masterProductId?: string }, now = new Date()) {
  const row = await db.priceListRow.findUnique({ where: { id: input.rowId }, include: { upload: true } });
  if (!row || row.upload.status !== "REVIEW") return { error: "This row cannot be changed" } as const;
  if (input.masterProductId) {
    const master = await db.masterProduct.findFirst({ where: { id: input.masterProductId, mergedIntoId: null } });
    if (!master || row.price == null) return { error: "Choose a master product for a row with a valid price" } as const;
    const current = (await currentPrices([master.id], now)).get(master.id) ?? null;
    const unchanged = current !== null && Math.abs(current - Number(row.price)) < 0.005;
    return { row: await db.priceListRow.update({ where: { id: row.id }, data: { masterProductId: master.id, currentPrice: current, match: unchanged ? "UNCHANGED" : "MATCHED", approved: !unchanged, problem: null } }) };
  }
  if (input.approved !== undefined) {
    if (input.approved && row.match !== "MATCHED") return { error: "Only matched rows with a changed price can be published" } as const;
    return { row: await db.priceListRow.update({ where: { id: row.id }, data: { approved: input.approved } }) };
  }
  return { error: "Nothing to change" } as const;
}

/** Publishes every approved, matched row as an official price with the upload's source and reference, or rejects the file. */
export async function settleUpload(input: { uploadId: string; action: "publish" | "reject"; note?: string; actorId: string }, now = new Date()) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PriceListUpload" WHERE id = ${input.uploadId} FOR UPDATE`;
    const upload = await tx.priceListUpload.findUnique({ where: { id: input.uploadId }, include: { rows: { where: { approved: true, match: "MATCHED" } } } });
    if (!upload || upload.status !== "REVIEW") return { error: "This upload was already settled" } as const;
    let published = 0;
    if (input.action === "publish") {
      for (const row of upload.rows) {
        await recordMasterPrice(tx, { masterProductId: row.masterProductId!, price: Number(row.price), effectiveFrom: upload.effectiveFrom, source: upload.source, reference: upload.reference, actorId: input.actorId }, now);
        published++;
      }
    }
    await tx.priceListUpload.update({ where: { id: upload.id }, data: { status: input.action === "publish" ? "PUBLISHED" : "REJECTED", reviewedById: input.actorId, reviewedAt: now, reviewNote: input.note ?? null } });
    await tx.auditLog.create({ data: { userId: input.actorId, action: input.action === "publish" ? "catalogue.price_list_published" : "catalogue.price_list_rejected", entityType: "price_list", entityId: upload.id, metadata: { published, reference: upload.reference, note: input.note ?? null } } });
    return { published };
  });
}

// ---------- duplicate master products ----------

/** Groups of master entries that look like the same medicine: the same name, or the same salt, strength, and company. */
export async function duplicateCandidates(limit = 100): Promise<DuplicateCandidate[]> {
  const masters = await db.masterProduct.findMany({
    where: { mergedIntoId: null },
    select: { id: true, name: true, generic: true, company: true, strength: true, barcode: true, drapRegistrationNo: true, unitsPerPack: true, tabletsPerStrip: true, officialRetailPrice: true, _count: { select: { products: true } } }
  });
  const groups = new Map<string, { reason: string; ids: Set<string> }>();
  const add = (key: string, reason: string, id: string) => {
    const group = groups.get(key) ?? { reason, ids: new Set<string>() };
    group.ids.add(id);
    groups.set(key, group);
  };
  for (const master of masters) {
    add(`name:${normalise(master.name)}`, "Same name", master.id);
    if (master.generic && master.strength && master.company) add(`salt:${normalise(master.generic)}|${normalise(master.strength)}|${normalise(master.company)}|${master.unitsPerPack}x${master.tabletsPerStrip}`, "Same salt, strength, company, and pack", master.id);
  }
  const byId = new Map(masters.map((master) => [master.id, master]));
  const seen = new Set<string>();
  const result: DuplicateCandidate[] = [];
  for (const group of groups.values()) {
    if (group.ids.size < 2) continue;
    const key = [...group.ids].sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ reason: group.reason, products: [...group.ids].map((id) => byId.get(id)!).map((master) => ({
      id: master.id, name: master.name, generic: master.generic, company: master.company, strength: master.strength, barcode: master.barcode, drapRegistrationNo: master.drapRegistrationNo,
      unitsPerPack: master.unitsPerPack, tabletsPerStrip: master.tabletsPerStrip, officialRetailPrice: master.officialRetailPrice == null ? null : Number(master.officialRetailPrice), shops: master._count.products
    })) });
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Merges a duplicate master entry into the one kept. Shops stocking only the duplicate are relinked to the kept
 * entry; a shop that stocks both keeps its duplicate item (with its stock and history) as its own item, unlinked.
 * The duplicate is hidden everywhere, its barcode and registration move over if the kept entry lacks them, and
 * counters drop it on their next sync. Nothing is deleted.
 */
export async function mergeMasterProducts(input: { keepId: string; mergeId: string; reason?: string; actorId: string }) {
  if (input.keepId === input.mergeId) return { error: "Choose two different products" } as const;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "MasterProduct" WHERE id IN (${input.keepId}, ${input.mergeId}) FOR UPDATE`;
    const [keep, merge] = await Promise.all([tx.masterProduct.findUnique({ where: { id: input.keepId } }), tx.masterProduct.findUnique({ where: { id: input.mergeId } })]);
    if (!keep || !merge || keep.mergedIntoId || merge.mergedIntoId) return { error: "Both products must exist and not be merged already" } as const;
    if (keep.unitsPerPack !== merge.unitsPerPack || keep.tabletsPerStrip !== merge.tabletsPerStrip) return { error: "Pack sizes differ, so these are not the same product; correct the pack size first" } as const;

    const linked = await tx.product.findMany({ where: { masterProductId: merge.id } });
    const branchesWithKept = new Set((await tx.product.findMany({ where: { masterProductId: keep.id, branchId: { in: linked.map((product) => product.branchId) } }, select: { branchId: true } })).map((product) => product.branchId));
    let relinked = 0;
    let unlinked = 0;
    for (const product of linked) {
      if (branchesWithKept.has(product.branchId)) {
        // Keep the shop item as its own, carrying the pack details it used to take from the master entry.
        await tx.product.update({ where: { id: product.id }, data: { masterProductId: null, unitsPerPack: product.unitsPerPack ?? merge.unitsPerPack, tabletsPerStrip: product.tabletsPerStrip ?? merge.tabletsPerStrip, generic: product.generic ?? merge.generic, company: product.company ?? merge.company } });
        unlinked++;
      } else {
        await tx.product.update({ where: { id: product.id }, data: { masterProductId: keep.id } });
        relinked++;
      }
    }

    const moveBarcode = !keep.barcode && merge.barcode;
    const moveRegistration = !keep.drapRegistrationNo && merge.drapRegistrationNo;
    await tx.masterProduct.update({ where: { id: merge.id }, data: { mergedIntoId: keep.id, ...(moveBarcode ? { barcode: null } : {}), ...(moveRegistration ? { drapRegistrationNo: null } : {}) } });
    // Updating the kept entry also moves it up the counters' master-list cursor, so they pick up the change.
    await tx.masterProduct.update({ where: { id: keep.id }, data: { ...(moveBarcode ? { barcode: merge.barcode } : {}), ...(moveRegistration ? { drapRegistrationNo: merge.drapRegistrationNo } : {}), name: keep.name } });

    const record = await tx.masterProductMerge.create({ data: { keptId: keep.id, mergedId: merge.id, mergedName: merge.name, performedById: input.actorId, reason: input.reason ?? null, branchProductsRelinked: relinked, branchProductsUnlinked: unlinked, details: { keptName: keep.name, movedBarcode: moveBarcode ? merge.barcode : null, movedRegistration: moveRegistration ? merge.drapRegistrationNo : null, unlinkedProductIds: linked.filter((product) => branchesWithKept.has(product.branchId)).map((product) => product.id) } } });
    await tx.auditLog.create({ data: { userId: input.actorId, action: "catalogue.master_products_merged", entityType: "master_product", entityId: keep.id, metadata: { mergedId: merge.id, mergedName: merge.name, relinked, unlinked, reason: input.reason ?? null } } });
    return { merge: record, relinked, unlinked };
  });
}
