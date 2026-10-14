import ExcelJS from "exceljs";
import { parseCsv } from "../lib/csv";

export const MAX_IMPORT_ROWS = 20_000;

export interface Sheet {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/** Text of an Excel cell as a person would read it; dates become YYYY-MM-DD. */
function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
    if ("error" in value) return "";
  }
  return String(value).trim();
}

/** Reads the first sheet of an .xlsx file, or a .csv file: the first non-empty row is the header. */
export async function readSheet(fileName: string, content: Buffer): Promise<Sheet | { error: string }> {
  let grid: string[][];
  if (/\.xlsx$/i.test(fileName)) {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(content as unknown as ArrayBuffer);
    } catch {
      return { error: "This is not a readable Excel (.xlsx) file" };
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) return { error: "The workbook has no sheets" };
    grid = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let column = 1; column <= sheet.columnCount; column++) cells.push(cellText(row.getCell(column).value));
      grid.push(cells);
    });
  } else if (/\.csv$/i.test(fileName)) {
    grid = parseCsv(content.toString("utf8"));
  } else {
    return { error: "Upload an Excel (.xlsx) or CSV file. Older .xls files: open in Excel and save as .xlsx" };
  }
  const nonEmpty = grid.filter((row) => row.some((cell) => cell.trim()));
  if (nonEmpty.length < 2) return { error: "The file needs a heading row and at least one row of data" };
  if (nonEmpty.length - 1 > MAX_IMPORT_ROWS) return { error: `Import at most ${MAX_IMPORT_ROWS} rows at a time; split the file` };

  // Blank or repeated headings get a column letter so every column can be mapped.
  const seen = new Map<string, number>();
  const headers = nonEmpty[0].map((cell, index) => {
    const base = cell.trim() || `Column ${String.fromCharCode(65 + (index % 26))}${index >= 26 ? Math.floor(index / 26) : ""}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count > 1 ? `${base} (${count})` : base;
  });
  const rows = nonEmpty.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, (cells[index] ?? "").trim()])));
  return { headers, rows };
}

// ---------- values ----------

/** "1,250", "Rs. 1,250.50", "(300)" for -300. Empty gives null; anything else unreadable gives NaN. */
export function parseAmount(text: string | undefined): number | null {
  const value = (text ?? "").trim();
  if (!value) return null;
  const negative = /^\(.*\)$/.test(value) || /^-/.test(value) || /\bcr\b/i.test(value);
  const digits = value.replace(/rs\.?|pkr|cr|dr|[(),\s]/gi, "").replace(/^-/, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return NaN;
  const amount = Math.round(Number(digits) * 100) / 100;
  return negative ? -amount : amount;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const endOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const fullYear = (year: number) => year < 100 ? 2000 + year : year;

/**
 * A date as shops write it: 2027-03-31, 31/03/2027, 31-3-27, 03/2027 or Mar-27 or 3/27 (expiry month: the last day of it),
 * or an Excel date number. Day first, as in Pakistan. Returns YYYY-MM-DD, null when empty, or "invalid".
 */
export function parseDate(text: string | undefined): string | null | "invalid" {
  const value = (text ?? "").trim().toLowerCase();
  if (!value) return null;
  const iso = (year: number, month: number, day: number) => {
    if (month < 1 || month > 12 || day < 1 || day > endOfMonth(year, month) || year < 1990 || year > 2100) return "invalid" as const;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return iso(+match[1], +match[2], +match[3]);
  match = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (match) return iso(fullYear(+match[3]), +match[2], +match[1]);
  match = value.match(/^(\d{1,2})[/.-](\d{2,4})$/);
  if (match) { const year = fullYear(+match[2]); return iso(year, +match[1], endOfMonth(year, +match[1])); }
  match = value.match(/^([a-z]{3})[a-z]*[\s/.-]*(\d{2,4})$/);
  if (match && MONTHS.includes(match[1])) { const year = fullYear(+match[2]); const month = MONTHS.indexOf(match[1]) + 1; return iso(year, month, endOfMonth(year, month)); }
  if (/^\d{5}(\.\d+)?$/.test(value)) {
    // Excel serial date: days since 1899-12-30.
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(value)) * 86_400_000);
    return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  return "invalid";
}

/** "10x10", "10 x 10", "1*14", "10's" → strips per pack and tablets per strip. */
export function parsePacking(text: string | undefined): { unitsPerPack: number; tabletsPerStrip: number } | null {
  const value = (text ?? "").trim().toLowerCase();
  let match = value.match(/^(\d{1,4})\s*[x*×]\s*(\d{1,4})/);
  if (match && +match[1] > 0 && +match[2] > 0) return { unitsPerPack: +match[1], tabletsPerStrip: +match[2] };
  match = value.match(/^(\d{1,4})\s*'?s$/);
  if (match && +match[1] > 0) return { unitsPerPack: 1, tabletsPerStrip: +match[1] };
  return null;
}

export const cleanPhone = (text: string | undefined) => {
  const digits = (text ?? "").replace(/[^\d+]/g, "");
  return digits.length >= 7 ? digits : null;
};
