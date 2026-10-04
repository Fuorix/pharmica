/**
 * Reads the GS1 DataMatrix ("2D code") printed on medicine packs under DRAP rules: GTIN (01), expiry (17),
 * batch/lot (10), and serial (21). Handles the bracketed human form, raw scanner output with GS (0x1D)
 * separators, and scanner symbology prefixes. Anything uncertain is reported in `warnings` so the person
 * receiving stock can correct it by hand.
 */
export interface Gs1Scan {
  /** 14-digit GTIN as encoded. */
  gtin?: string;
  /** The code printed under the 1D barcode: the GTIN without its leading 0 when it has one. */
  barcode?: string;
  /** YYYY-MM-DD. */
  expiryDate?: string;
  batchNo?: string;
  serialNumber?: string;
  /** True when product, batch, and expiry were all read with confidence. */
  complete: boolean;
  warnings: string[];
}

const GS = "\u001d";
/** Fixed-length application identifiers and their data length. */
const FIXED: Record<string, number> = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2 };
/** Variable-length identifiers (ended by GS or the end of the code) and their maximum length. */
const VARIABLE: Record<string, number> = { "10": 20, "21": 20, "22": 20, "30": 8, "37": 8, "240": 30, "241": 30, "710": 20, "711": 20, "712": 20, "713": 20, "714": 20 };

export function gtinCheckDigitValid(digits: string): boolean {
  if (!/^\d{8,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  const sum = [...body].reverse().reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/** GS1 dates are YYMMDD; a day of 00 means the last day of that month. */
function gs1Date(value: string): string | null {
  if (!/^\d{6}$/.test(value)) return null;
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  let day = Number(value.slice(4, 6));
  if (month < 1 || month > 12) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day === 0) day = lastDay;
  if (day > lastDay) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function identifierAt(text: string, position: number): string | null {
  for (const length of [2, 3]) {
    const candidate = text.slice(position, position + length);
    if (candidate in FIXED || candidate in VARIABLE) return candidate;
  }
  return null;
}

function readFields(input: string, warnings: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  const text = input.trim().replace(/^\][A-Za-z]\d/, "").replace(new RegExp(`^${GS}+`), "");

  if (text.includes("(")) {
    for (const match of text.matchAll(/\((\d{2,4})\)([^(]*)/g)) fields.set(match[1], match[2].replace(new RegExp(GS, "g"), "").trim());
    return fields;
  }

  let position = 0;
  while (position < text.length) {
    if (text[position] === GS) { position++; continue; }
    const ai = identifierAt(text, position);
    if (!ai) { warnings.push("Part of the code could not be read"); break; }
    position += ai.length;
    if (ai in FIXED) {
      fields.set(ai, text.slice(position, position + FIXED[ai]));
      position += FIXED[ai];
      continue;
    }
    const end = text.indexOf(GS, position);
    let value = text.slice(position, end === -1 ? undefined : end);
    if (end === -1 && position + value.length < text.length) value = text.slice(position);
    if (value.length > VARIABLE[ai]) warnings.push("A batch or serial number is longer than GS1 allows; the scanner may have dropped a separator");
    fields.set(ai, value);
    position += value.length;
  }
  return fields;
}

export function parseGs1(input: string): Gs1Scan {
  const warnings: string[] = [];
  const trimmed = input.trim();

  // A plain 1D barcode (EAN-8/13, UPC, GTIN-14) identifies the product only.
  if (/^\d{8}$|^\d{12,14}$/.test(trimmed)) {
    if (!gtinCheckDigitValid(trimmed)) warnings.push("The barcode check digit is wrong; scan again");
    const gtin = trimmed.padStart(14, "0");
    warnings.push("This is a 1D barcode: enter the batch and expiry by hand");
    return { gtin, barcode: gtin.startsWith("0") ? gtin.slice(1) : gtin, complete: false, warnings };
  }

  const fields = readFields(trimmed, warnings);
  const result: Gs1Scan = { complete: false, warnings };

  const gtin = fields.get("01");
  if (gtin) {
    if (!/^\d{14}$/.test(gtin) || !gtinCheckDigitValid(gtin)) warnings.push("The product code (GTIN) failed its check; scan again or pick the product by hand");
    result.gtin = gtin;
    result.barcode = gtin.startsWith("0") ? gtin.slice(1) : gtin;
  } else warnings.push("No product code (GTIN) found");

  const expiry = fields.get("17");
  if (expiry) {
    const date = gs1Date(expiry);
    if (date) result.expiryDate = date;
    else warnings.push("The expiry date in the code is not a valid date");
  } else warnings.push("No expiry date found");

  const batch = fields.get("10");
  const serial = fields.get("21");
  if (batch) result.batchNo = batch;
  else warnings.push("No batch number found");
  if (serial) result.serialNumber = serial;

  // Without a separator, a batch number followed by a serial runs together and cannot be split reliably.
  if (!trimmed.includes(GS) && !trimmed.includes("(") && batch && !serial && /21[A-Za-z0-9]{4,}$/.test(batch)) {
    warnings.push("Batch and serial may have run together (the scanner sent no separator); check the batch number");
  }

  result.complete = Boolean(result.gtin && result.expiryDate && result.batchNo) && warnings.length === 0;
  return result;
}
