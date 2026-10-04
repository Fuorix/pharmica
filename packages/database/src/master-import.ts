// Runs both under the bundler (API) and directly in Node (CLI and seed), so it uses only erasable TypeScript syntax.
import type { Prisma, PrismaClient } from "@prisma/client";

export interface MasterRow {
  name: string;
  brand?: string;
  generic?: string;
  company?: string;
  dosageForm?: string;
  strength?: string;
  unitsPerPack: number;
  tabletsPerStrip: number;
  officialRetailPrice?: number;
  isPrescriptionOnly: boolean;
  isControlled: boolean;
  barcode?: string;
  drapRegistrationNo?: string;
}

export interface ImportIssue {
  line: number;
  message: string;
}

export interface ImportResult {
  created: number;
  updated: number;
  priceChanges: number;
  unchanged: number;
  issues: ImportIssue[];
}

export const MASTER_CSV_COLUMNS = ["name", "brand", "generic", "company", "dosageForm", "strength", "unitsPerPack", "tabletsPerStrip", "officialRetailPrice", "isPrescriptionOnly", "isControlled", "barcode", "drapRegistrationNo"] as const;

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === "\"" && input[index + 1] === "\"") { field += "\""; index++; }
      else if (char === "\"") quoted = false;
      else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index++;
      row.push(field); field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

const optional = (value: string | undefined) => value?.trim() || undefined;

function toBoolean(value: string | undefined): boolean | null {
  const normalised = (value ?? "").trim().toLowerCase();
  if (["", "0", "no", "n", "false"].includes(normalised)) return false;
  if (["1", "yes", "y", "true"].includes(normalised)) return true;
  return null;
}

function toCount(value: string | undefined): number | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return 1;
  const number = Number(trimmed);
  return Number.isInteger(number) && number >= 1 && number <= 1000 ? number : null;
}

/** Validates CSV rows (first row is the header) into master rows, collecting problems by line number. */
export function readMasterCsv(text: string): { rows: Array<MasterRow & { line: number }>; issues: ImportIssue[] } {
  const [header, ...records] = parseCsv(text);
  const issues: ImportIssue[] = [];
  if (!header) return { rows: [], issues: [{ line: 1, message: "The file is empty" }] };
  const columns = header.map((column) => column.trim());
  if (!columns.includes("name")) return { rows: [], issues: [{ line: 1, message: "A \"name\" column is required" }] };

  const rows: Array<MasterRow & { line: number }> = [];
  records.forEach((record, index) => {
    const line = index + 2;
    const get = (column: string) => record[columns.indexOf(column)];
    const name = optional(get("name"));
    const unitsPerPack = toCount(get("unitsPerPack"));
    const tabletsPerStrip = toCount(get("tabletsPerStrip"));
    const priceText = optional(get("officialRetailPrice"));
    const price = priceText === undefined ? undefined : Number(priceText);
    const isPrescriptionOnly = toBoolean(get("isPrescriptionOnly"));
    const isControlled = toBoolean(get("isControlled"));

    const problem = !name ? "name is missing"
      : unitsPerPack === null ? "unitsPerPack must be a whole number from 1 to 1000"
      : tabletsPerStrip === null ? "tabletsPerStrip must be a whole number from 1 to 1000"
      : price !== undefined && (!Number.isFinite(price) || price < 0) ? "officialRetailPrice must be a non-negative number"
      : isPrescriptionOnly === null || isControlled === null ? "flags must be yes/no, true/false, or 1/0"
      : null;
    if (problem) return void issues.push({ line, message: problem });

    rows.push({
      line,
      name: name!,
      brand: optional(get("brand")),
      generic: optional(get("generic")),
      company: optional(get("company")),
      dosageForm: optional(get("dosageForm")),
      strength: optional(get("strength")),
      unitsPerPack: unitsPerPack!,
      tabletsPerStrip: tabletsPerStrip!,
      officialRetailPrice: price === undefined ? undefined : Math.round(price * 100) / 100,
      // A controlled (scheduled) drug always needs a prescription.
      isPrescriptionOnly: isPrescriptionOnly! || isControlled!,
      isControlled: isControlled!,
      barcode: optional(get("barcode")),
      drapRegistrationNo: optional(get("drapRegistrationNo"))
    });
  });
  return { rows, issues };
}

type MasterClient = Pick<PrismaClient, "masterProduct" | "masterPriceHistory" | "$transaction">;

async function findExisting(db: MasterClient, row: MasterRow) {
  if (row.drapRegistrationNo) {
    const match = await db.masterProduct.findUnique({ where: { drapRegistrationNo: row.drapRegistrationNo } });
    if (match) return match;
  }
  if (row.barcode) {
    const match = await db.masterProduct.findUnique({ where: { barcode: row.barcode } });
    if (match) return match;
  }
  return db.masterProduct.findFirst({
    where: { name: { equals: row.name, mode: "insensitive" }, company: row.company ? { equals: row.company, mode: "insensitive" } : null }
  });
}

/**
 * Creates or updates master products. Safe to repeat: unchanged rows are left alone, and a changed price is
 * appended to the price history (never overwritten) with the given source and reference.
 */
export async function importMasterProducts(
  db: MasterClient,
  rows: Array<MasterRow & { line?: number }>,
  options: { source: string; reference?: string; recordedById?: string; effectiveFrom?: Date }
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, priceChanges: 0, unchanged: 0, issues: [] };
  const effectiveFrom = options.effectiveFrom ?? new Date();

  for (const row of rows) {
    const { line, officialRetailPrice, ...fields } = row;
    try {
      const existing = await findExisting(db, row);
      const priceEntry = (masterProductId: string, price: number): Prisma.MasterPriceHistoryCreateArgs => ({
        data: { masterProductId, price, effectiveFrom, source: options.source, reference: options.reference, recordedById: options.recordedById }
      });

      if (!existing) {
        await db.$transaction(async (transaction) => {
          const created = await transaction.masterProduct.create({ data: { ...fields, officialRetailPrice, source: options.source } });
          if (officialRetailPrice !== undefined) await transaction.masterPriceHistory.create(priceEntry(created.id, officialRetailPrice));
        });
        result.created++;
        continue;
      }

      const changedFields = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== undefined && existing[key as keyof typeof existing] !== value));
      const priceChanged = officialRetailPrice !== undefined && (existing.officialRetailPrice == null || Number(existing.officialRetailPrice) !== officialRetailPrice);
      if (!Object.keys(changedFields).length && !priceChanged) { result.unchanged++; continue; }

      await db.$transaction(async (transaction) => {
        await transaction.masterProduct.update({ where: { id: existing.id }, data: { ...changedFields, ...(priceChanged ? { officialRetailPrice } : {}) } });
        if (priceChanged) await transaction.masterPriceHistory.create(priceEntry(existing.id, officialRetailPrice!));
      });
      if (Object.keys(changedFields).length) result.updated++;
      if (priceChanged) result.priceChanges++;
    } catch (error) {
      result.issues.push({ line: line ?? 0, message: error instanceof Error && error.message.includes("Unique constraint") ? "barcode or registration number already belongs to another product" : "could not be saved" });
    }
  }
  return result;
}
