import type { ImportCandidate, ImportKind } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { normaliseName, rankMatches } from "@pharmica/domain";
import { IMPORT_FIELDS } from "./fields";
import { cleanPhone, parseAmount, parseDate, parsePacking } from "./read";

export type RowStatus = "READY" | "NEEDS_REVIEW" | "INVALID" | "SKIPPED";
export interface CheckedRow { data: Record<string, unknown>; status: RowStatus; problems: string[]; action: string | null; masterProductId: string | null; productId: string | null; score: number | null; candidates: ImportCandidate[] | null }

export interface StockData {
  name: string; barcode: string | null; company: string | null; generic: string | null;
  unitsPerPack: number | null; tabletsPerStrip: number | null;
  batchNo: string | null; expiry: string | null; packs: number; units: number;
  costPrice: number | null; retailPrice: number | null; rack: string | null;
}

const hasStock = (data: StockData) => data.packs > 0 || data.units > 0;

/** Problems with a stock row whatever it is matched to; the retail price can come from the item it matches. */
export function stockProblems(data: StockData, fallbackRetail: number | null, today: string): string[] {
  const problems: string[] = [];
  if (!hasStock(data)) return problems;
  if (!data.expiry) problems.push("Expiry date is needed for stock");
  else if (data.expiry <= today) problems.push("Already expired; write it off instead of importing it");
  if (data.retailPrice == null && fallbackRetail == null) problems.push("Retail price is needed: none in the file or on the master list");
  return problems;
}

function readStock(cells: (key: string) => string, problems: string[]): StockData {
  const number = (key: string, label: string, whole = false) => {
    const value = parseAmount(cells(key));
    if (value === null) return null;
    if (Number.isNaN(value) || value < 0 || (whole && !Number.isInteger(value))) { problems.push(`${label} "${cells(key)}" is not a valid ${whole ? "whole number" : "amount"}`); return null; }
    return value;
  };
  const expiry = parseDate(cells("expiry"));
  if (expiry === "invalid") problems.push(`Expiry "${cells("expiry")}" is not a date`);
  const packing = parsePacking(cells("packing"));
  if (cells("packing") && !packing) problems.push(`Packing "${cells("packing")}" should look like 10x10`);
  const units = number("units", "Loose units", true);
  return {
    name: cells("name"), barcode: cells("barcode") || null, company: cells("company") || null, generic: cells("generic") || null,
    unitsPerPack: number("unitsPerPack", "Strips per pack", true) || packing?.unitsPerPack || null,
    tabletsPerStrip: number("tabletsPerStrip", "Tablets per strip", true) || packing?.tabletsPerStrip || null,
    batchNo: cells("batchNo") || null, expiry: expiry === "invalid" ? null : expiry,
    packs: number("packs", "Stock in packs") ?? 0, units: units ?? 0,
    costPrice: number("costPrice", "Cost"), retailPrice: number("retailPrice", "Retail price"), rack: cells("rack") || null
  };
}

const packingOf = (master: { unitsPerPack: number; tabletsPerStrip: number }) => `${master.unitsPerPack}x${master.tabletsPerStrip}`;

/**
 * Reads every row through the column map and decides what each one becomes. Clear cases are ready; anything unclear
 * waits for a person; bad rows are left out with the reason. Nothing is written to the shop's records here.
 */
export async function checkRows(input: { kind: ImportKind; branchId: string; columnMap: Record<string, string>; rows: Array<{ line: number; raw: Record<string, string> }> }, now = new Date()): Promise<CheckedRow[]> {
  const today = new Date(now.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);
  const cellsOf = (raw: Record<string, string>) => (key: string) => (input.columnMap[key] ? raw[input.columnMap[key]] ?? "" : "").trim();
  const required = IMPORT_FIELDS[input.kind].filter((field) => field.required);

  if (input.kind === "STOCK") return checkStock(input.rows.map((row) => ({ ...row, cells: cellsOf(row.raw) })), input.branchId, today, required.map((field) => field.key));

  const existing = input.kind === "CUSTOMERS"
    ? await db.customer.findMany({ where: { branchId: input.branchId }, select: { name: true, phone: true } })
    : await db.supplier.findMany({ where: { branchId: input.branchId }, select: { name: true, phone: true } });
  const existingPhones = new Set(existing.map((entry) => entry.phone).filter(Boolean));
  const existingNames = new Set(existing.map((entry) => entry.name.trim().toLowerCase()));
  const seenKeys = new Map<string, number>();

  return input.rows.map((row) => {
    const cells = cellsOf(row.raw);
    const problems: string[] = [];
    const name = cells("name");
    if (!name) problems.push("Name is missing");
    const balance = parseAmount(cells("balance"));
    if (Number.isNaN(balance)) problems.push(`Balance "${cells("balance")}" is not an amount`);
    const phone = cleanPhone(cells("phone"));
    const data: Record<string, unknown> = { name, phone, balance: Number.isNaN(balance) ? null : balance ?? 0 };
    if (input.kind === "CUSTOMERS") {
      const limit = parseAmount(cells("creditLimit"));
      if (Number.isNaN(limit) || (limit ?? 0) < 0) problems.push(`Credit limit "${cells("creditLimit")}" is not a valid amount`);
      const since = parseDate(cells("since"));
      if (since === "invalid") problems.push(`Date "${cells("since")}" is not a date`);
      else if (since && since > today) problems.push("The owed-since date is in the future");
      // Blank means no limit for an existing credit customer; 0 means no further credit.
      data.creditLimit = Number.isNaN(limit) ? null : limit;
      data.since = since === "invalid" ? null : since;
    } else {
      data.address = cells("address") || null;
    }
    // Customers are the same person by mobile number; suppliers by name.
    const key = input.kind === "CUSTOMERS" ? phone ?? `name:${name.toLowerCase()}` : name.toLowerCase();
    const earlier = seenKeys.get(key);
    if (name && earlier) problems.push(`Same ${input.kind === "CUSTOMERS" && phone ? "mobile" : "name"} as line ${earlier}`);
    else if (name) seenKeys.set(key, row.line);
    if (problems.length) return { data, status: "INVALID", problems, action: null, masterProductId: null, productId: null, score: null, candidates: null };
    const already = input.kind === "CUSTOMERS" ? (phone ? existingPhones.has(phone) : existingNames.has(name.toLowerCase())) : existingNames.has(name.toLowerCase());
    if (already) return { data, status: "SKIPPED", problems: [`Already in Pharmica, so it is not added again`], action: "SKIP", masterProductId: null, productId: null, score: null, candidates: null };
    return { data, status: "READY", problems: [], action: "CREATE", masterProductId: null, productId: null, score: null, candidates: null };
  });
}

async function checkStock(rows: Array<{ line: number; cells: (key: string) => string }>, branchId: string, today: string, required: string[]): Promise<CheckedRow[]> {
  const masters = await db.masterProduct.findMany({ where: { mergedIntoId: null }, select: { id: true, name: true, company: true, barcode: true, unitsPerPack: true, tabletsPerStrip: true, officialRetailPrice: true } });
  const products = await db.product.findMany({ where: { branchId }, select: { id: true, name: true, barcode: true, masterProductId: true, retailPriceOverride: true, batches: { select: { batchNo: true } } } });
  const masterByBarcode = new Map(masters.filter((master) => master.barcode).map((master) => [master.barcode!, master]));
  const masterById = new Map(masters.map((master) => [master.id, master]));
  const productByBarcode = new Map(products.filter((product) => product.barcode).map((product) => [product.barcode!, product]));
  const productByMaster = new Map(products.filter((product) => product.masterProductId).map((product) => [product.masterProductId!, product]));
  const productByName = new Map(products.map((product) => [normaliseName(product.name).join(" "), product]));
  // Only master entries sharing a word with the name are compared, so thousands of rows stay fast.
  const byWord = new Map<string, typeof masters>();
  for (const master of masters) for (const word of new Set(normaliseName(master.name).filter((word) => word.length >= 3 && !/^\d/.test(word)))) byWord.set(word, [...(byWord.get(word) ?? []), master]);

  return rows.map(({ cells }) => {
    const problems: string[] = [];
    for (const key of required) if (!cells(key)) problems.push("Item name is missing");
    const data = readStock(cells, problems);
    const result = (status: RowStatus, extra: Partial<CheckedRow>): CheckedRow => ({ data: data as unknown as Record<string, unknown>, status, problems, action: null, masterProductId: null, productId: null, score: null, candidates: null, ...extra });
    if (problems.length) return result("INVALID", {});

    const existing = (data.barcode && productByBarcode.get(data.barcode)) || productByName.get(normaliseName(data.name).join(" "));
    const exactMaster = data.barcode ? masterByBarcode.get(data.barcode) : undefined;
    const target = existing ?? (exactMaster ? productByMaster.get(exactMaster.id) : undefined);
    if (target) {
      const master = target.masterProductId ? masterById.get(target.masterProductId) : undefined;
      problems.push(...stockProblems(data, target.retailPriceOverride != null ? Number(target.retailPriceOverride) : master?.officialRetailPrice != null ? Number(master.officialRetailPrice) : null, today));
      if (problems.length) return result("INVALID", { action: "EXISTING", productId: target.id });
      if (hasStock(data) && data.batchNo && target.batches.some((batch) => batch.batchNo === data.batchNo)) return result("SKIPPED", { action: "EXISTING", productId: target.id, problems: [`Batch ${data.batchNo} of ${target.name} is already in stock, so it is not added again`] });
      return result("READY", { action: "EXISTING", productId: target.id, score: 1 });
    }
    if (exactMaster) {
      problems.push(...stockProblems(data, exactMaster.officialRetailPrice != null ? Number(exactMaster.officialRetailPrice) : null, today));
      return result(problems.length ? "INVALID" : "READY", { action: "MASTER", masterProductId: exactMaster.id, score: 1 });
    }

    const words = normaliseName(data.name).filter((word) => word.length >= 3 && !/^\d/.test(word));
    const pool = [...new Set(words.flatMap((word) => byWord.get(word) ?? []))];
    const ranked = rankMatches(data.name, pool, (master) => master.name);
    const candidates: ImportCandidate[] = ranked.candidates.map(({ item, score }) => ({ id: item.id, name: item.name, company: item.company, packing: packingOf(item), officialRetailPrice: item.officialRetailPrice == null ? null : Number(item.officialRetailPrice), score }));
    if (ranked.verdict === "matched") {
      const best = ranked.candidates[0].item;
      // A different pack size from the master entry means it may be another product: ask.
      const packDiffers = (data.unitsPerPack && data.unitsPerPack !== best.unitsPerPack) || (data.tabletsPerStrip && data.tabletsPerStrip !== best.tabletsPerStrip);
      problems.push(...stockProblems(data, best.officialRetailPrice != null ? Number(best.officialRetailPrice) : null, today));
      if (problems.length) return result("INVALID", { action: "MASTER", masterProductId: best.id, candidates });
      return result(packDiffers ? "NEEDS_REVIEW" : "READY", { action: "MASTER", masterProductId: best.id, score: ranked.candidates[0].score, candidates, problems: packDiffers ? [`Packing in the file differs from ${best.name} (${packingOf(best)})`] : [] });
    }
    if (ranked.verdict === "review") {
      return result("NEEDS_REVIEW", { action: null, score: ranked.candidates[0].score, candidates, problems: ["Several master-list medicines look like this one: choose one, or add it as the shop's own item"] });
    }
    problems.push(...stockProblems(data, null, today));
    return result(problems.length ? "INVALID" : "READY", { action: "NEW", problems: problems.length ? problems : [] });
  });
}

/** Re-checks a stock row after a person chose what it is, so a decision cannot slip past a missing price or expiry. */
export async function checkDecision(row: { data: Prisma.JsonValue }, decision: { action: string; masterProductId?: string; productId?: string }, branchId: string, now = new Date()): Promise<{ status: RowStatus; problems: string[] } | { error: string }> {
  const today = new Date(now.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);
  const data = row.data as unknown as StockData;
  if (decision.action === "SKIP") return { status: "SKIPPED", problems: ["Left out by the reviewer"] };
  if (decision.action === "MASTER") {
    const master = decision.masterProductId ? await db.masterProduct.findFirst({ where: { id: decision.masterProductId, mergedIntoId: null } }) : null;
    if (!master) return { error: "Choose a master-list medicine" };
    const problems = stockProblems(data, master.officialRetailPrice != null ? Number(master.officialRetailPrice) : null, today);
    return { status: problems.length ? "INVALID" : "READY", problems };
  }
  if (decision.action === "EXISTING") {
    const product = decision.productId ? await db.product.findFirst({ where: { id: decision.productId, branchId }, include: { masterProduct: true } }) : null;
    if (!product) return { error: "Choose an item this branch already has" };
    const problems = stockProblems(data, product.retailPriceOverride != null ? Number(product.retailPriceOverride) : product.masterProduct?.officialRetailPrice != null ? Number(product.masterProduct.officialRetailPrice) : null, today);
    return { status: problems.length ? "INVALID" : "READY", problems };
  }
  if (decision.action === "NEW") {
    const problems = stockProblems(data, null, today);
    return { status: problems.length ? "INVALID" : "READY", problems };
  }
  return { error: "Unknown choice" };
}

