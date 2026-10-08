import { db } from "@pharmica/database/client";

/** Every table an owner can take away, in the order a reader would want them. */
export const EXPORT_ENTITIES = [
  "branches", "users", "devices", "products", "batches", "suppliers", "purchases", "purchaseLines", "stockMovements",
  "customers", "customerLedger", "supplierLedger", "sales", "saleLines", "saleReturns", "saleReturnLines", "shifts",
  "expenses", "controlledDrugRecords", "priceChangeReports"
] as const;
export type ExportEntity = typeof EXPORT_ENTITIES[number];

type Row = Record<string, unknown>;

/**
 * One table of the organisation's data. Secrets never leave: password and PIN hashes, device secrets and
 * activation codes are left out, and sessions are not exported at all.
 */
export async function exportTable(organisationId: string, entity: ExportEntity): Promise<Row[]> {
  const inOrg = { branch: { organisationId } };
  switch (entity) {
    case "branches": return db.branch.findMany({ where: { organisationId }, orderBy: { name: "asc" } });
    case "users": return db.user.findMany({ where: { organisationId }, omit: { credentialHash: true, pinHash: true }, orderBy: { createdAt: "asc" } });
    case "devices": return db.device.findMany({ where: inOrg, omit: { activationCode: true, secretHash: true }, orderBy: { createdAt: "asc" } });
    case "products": return db.product.findMany({ where: inOrg, orderBy: { createdAt: "asc" } });
    case "batches": return db.batch.findMany({ where: { product: inOrg }, orderBy: { createdAt: "asc" } });
    case "suppliers": return db.supplier.findMany({ where: inOrg, orderBy: { createdAt: "asc" } });
    case "purchases": return db.purchase.findMany({ where: inOrg, orderBy: { receivedAt: "asc" } });
    case "purchaseLines": return db.purchaseLine.findMany({ where: { purchase: inOrg } });
    case "stockMovements": return db.stockMovement.findMany({ where: inOrg, orderBy: { createdAt: "asc" } });
    case "customers": return db.customer.findMany({ where: inOrg, orderBy: { createdAt: "asc" } });
    case "customerLedger": return db.customerLedgerEntry.findMany({ where: inOrg, orderBy: { createdAt: "asc" } });
    case "supplierLedger": return db.supplierLedgerEntry.findMany({ where: inOrg, orderBy: { createdAt: "asc" } });
    case "sales": return db.sale.findMany({ where: inOrg, orderBy: { createdAt: "asc" } });
    case "saleLines": return db.saleLine.findMany({ where: { sale: inOrg } });
    case "saleReturns": return db.saleReturn.findMany({ where: { sale: inOrg }, orderBy: { createdAt: "asc" } });
    case "saleReturnLines": return db.saleReturnLine.findMany({ where: { saleReturn: { sale: inOrg } } });
    case "shifts": return db.shift.findMany({ where: inOrg, orderBy: { openedAt: "asc" } });
    case "expenses": return db.expense.findMany({ where: inOrg, orderBy: { spentAt: "asc" } });
    case "controlledDrugRecords": return db.controlledDrugRecord.findMany({ where: inOrg, orderBy: { createdAt: "asc" } });
    case "priceChangeReports": return db.priceChangeReport.findMany({ where: inOrg, orderBy: { createdAt: "asc" } });
  }
}

/** Prisma's Decimal (decimal.js), recognised by shape so it survives bundling. */
function isDecimal(value: unknown): value is { toString(): string } {
  return value != null && typeof value === "object" && "d" in value && "e" in value && "s" in value && typeof (value as { toFixed?: unknown }).toFixed === "function";
}

/** Plain values for JSON and CSV: money and quantities as numbers' exact text, dates as ISO strings. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (isDecimal(value)) return value.toString();
  return value;
}

export function plainRows(rows: Row[]): Row[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, plain(value)])));
}

function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Keep spreadsheet apps from running a cell as a formula.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: Row[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(plain(row[column]))).join(","))];
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
