import type { ImportField, ImportKind } from "@pharmica/contracts";

/**
 * The fields each template can fill, with the column headings shops' old software tends to use for them, so most
 * files map themselves. Headings are compared ignoring case, spaces, dots, and brackets.
 */
export const IMPORT_FIELDS: Record<ImportKind, Array<ImportField & { aliases: string[] }>> = {
  STOCK: [
    { key: "name", label: "Item name", required: true, aliases: ["name", "item", "item name", "itemname", "product", "product name", "medicine", "description", "item description", "brand"] },
    { key: "barcode", label: "Barcode", required: false, aliases: ["barcode", "bar code", "gtin", "ean", "code"] },
    { key: "company", label: "Company", required: false, aliases: ["company", "manufacturer", "mfg", "pharma", "make"] },
    { key: "generic", label: "Generic (salt)", required: false, aliases: ["generic", "salt", "formula", "composition"] },
    { key: "packing", label: "Packing (e.g. 10x10)", required: false, hint: "Strips per pack x tablets per strip, like 10x10 or 1x14", aliases: ["packing", "pack", "pack size", "packsize"] },
    { key: "unitsPerPack", label: "Strips per pack", required: false, aliases: ["strips per pack", "units per pack", "strips"] },
    { key: "tabletsPerStrip", label: "Tablets per strip", required: false, aliases: ["tablets per strip", "tabs per strip", "tablets"] },
    { key: "batchNo", label: "Batch number", required: false, aliases: ["batch", "batch no", "batchno", "batch number", "lot"] },
    { key: "expiry", label: "Expiry date", required: false, hint: "Needed for any item with stock", aliases: ["expiry", "exp", "exp date", "expiry date", "expire", "expiry dt"] },
    { key: "packs", label: "Stock in packs", required: false, aliases: ["qty", "quantity", "stock", "stock qty", "balance", "balance qty", "packs", "closing stock", "in stock"] },
    { key: "units", label: "Stock in loose units (tablets)", required: false, aliases: ["loose", "loose qty", "units", "loose units", "tablets in stock"] },
    { key: "costPrice", label: "Cost per pack", required: false, aliases: ["cost", "cost price", "purchase price", "purchase rate", "p rate", "prate", "trade price", "tp"] },
    { key: "retailPrice", label: "Retail price per pack", required: false, hint: "Leave blank to use the master-list price", aliases: ["retail", "retail price", "rate", "price", "mrp", "sale price", "sale rate", "rp", "s rate"] },
    { key: "rack", label: "Rack", required: false, aliases: ["rack", "location", "shelf", "rack no"] }
  ],
  CUSTOMERS: [
    { key: "name", label: "Customer name", required: true, aliases: ["name", "customer", "customer name", "party", "party name", "account", "account name"] },
    { key: "phone", label: "Mobile", required: false, aliases: ["phone", "mobile", "cell", "contact", "phone no", "mobile no", "cell no"] },
    { key: "balance", label: "Owes the shop (PKR)", required: false, hint: "A negative amount is an advance the shop holds", aliases: ["balance", "amount", "due", "receivable", "owes", "outstanding", "closing balance"] },
    { key: "since", label: "Owed since", required: false, hint: "Date of the oldest unpaid bill, for ageing", aliases: ["since", "date", "due since", "oldest bill", "last bill date"] },
    { key: "creditLimit", label: "Credit limit (PKR)", required: false, hint: "Blank = no limit, 0 = no credit", aliases: ["credit limit", "limit", "creditlimit"] }
  ],
  SUPPLIERS: [
    { key: "name", label: "Supplier name", required: true, aliases: ["name", "supplier", "supplier name", "distributor", "party", "party name", "company"] },
    { key: "phone", label: "Phone", required: false, aliases: ["phone", "mobile", "contact", "phone no", "cell"] },
    { key: "address", label: "Address", required: false, aliases: ["address", "city", "area"] },
    { key: "balance", label: "Shop owes (PKR)", required: false, hint: "A negative amount is an advance paid to the supplier", aliases: ["balance", "amount", "payable", "due", "outstanding", "closing balance"] }
  ]
};

export const normaliseHeader = (header: string) => header.toLowerCase().replace(/[._()\-:#/]+/g, " ").replace(/\s+/g, " ").trim();

/** Picks a column for each field from the headings; each column is used once, required fields first. */
export function guessColumnMap(kind: ImportKind, headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<string>();
  for (const field of IMPORT_FIELDS[kind]) {
    // Our own template headings are the field labels; other files use one of the usual names.
    const header = headers.find((candidate) => !used.has(candidate) && (field.aliases.includes(normaliseHeader(candidate)) || normaliseHeader(candidate) === normaliseHeader(field.label)));
    if (header) { map[field.key] = header; used.add(header); }
  }
  return map;
}

export function fieldsFor(kind: ImportKind): ImportField[] {
  return IMPORT_FIELDS[kind].map(({ aliases: _aliases, ...field }) => field);
}

export const KIND_LABELS: Record<ImportKind, string> = { STOCK: "Items and opening stock", CUSTOMERS: "Customers and what they owe", SUPPLIERS: "Suppliers and what the shop owes" };
