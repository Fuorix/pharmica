import { createHash } from "node:crypto";
import type { AuthUser, ImportCandidate, ImportDecision, ImportJobDetail, ImportJobSummary, ImportKind, ImportRowItem } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import ExcelJS from "exceljs";
import { canAccessScope } from "../auth/authorization";
import { requireCapability } from "../billing/subscriptions";
import { apiError } from "../lib/api-response";
import { checkDecision, checkRows } from "./check";
import { fieldsFor, guessColumnMap, IMPORT_FIELDS, KIND_LABELS } from "./fields";
import { readSheet } from "./read";

type JobRecord = Prisma.ImportJobGetPayload<object>;

/** Owners import into their own branches; Pharmica staff can run any import (assisted setup). */
export async function jobForUser(user: AuthUser, jobId: string): Promise<JobRecord | Response> {
  const job = await db.importJob.findUnique({ where: { id: jobId } });
  if (!job || !canAccessScope(user, job.organisationId, job.branchId)) return apiError(404, "IMPORT_NOT_FOUND", "No such import");
  return job;
}

/** Imports change the shop records, so an owner needs a subscription that allows managing the shop. */
export async function requireImportAllowed(user: AuthUser, organisationId: string): Promise<Response | null> {
  return user.role === "super-admin" ? null : requireCapability(organisationId, "manage");
}

export async function summaryOf(job: JobRecord): Promise<ImportJobSummary> {
  const [counts, branch, people] = await Promise.all([
    db.importRow.groupBy({ by: ["status"], where: { jobId: job.id }, _count: { _all: true } }),
    db.branch.findUnique({ where: { id: job.branchId }, select: { name: true } }),
    db.user.findMany({ where: { id: { in: [job.createdById, job.committedById].filter((id): id is string => !!id) } }, select: { id: true, name: true } })
  ]);
  const count = (status: string) => counts.find((row) => row.status === status)?._count._all ?? 0;
  const name = (id: string | null) => id ? people.find((person) => person.id === id)?.name ?? "Unknown" : null;
  return {
    id: job.id, kind: job.kind, kindLabel: KIND_LABELS[job.kind], status: job.status, fileName: job.fileName, organisationId: job.organisationId, branchId: job.branchId, branchName: branch?.name ?? "",
    rowCount: job.rowCount, counts: { ready: count("READY"), needsReview: count("NEEDS_REVIEW"), invalid: count("INVALID"), skipped: count("SKIPPED"), committed: count("COMMITTED") },
    createdBy: name(job.createdById) ?? "Unknown", createdAt: job.createdAt.toISOString(), committedBy: name(job.committedById), committedAt: job.committedAt?.toISOString() ?? null,
    lastError: job.lastError, summary: (job.summary ?? null) as Record<string, number> | null
  };
}

const FILTERS: Record<string, Prisma.ImportRowWhereInput> = {
  all: {},
  attention: { status: { in: ["NEEDS_REVIEW", "INVALID"] } },
  review: { status: "NEEDS_REVIEW" },
  ready: { status: "READY" },
  invalid: { status: "INVALID" },
  skipped: { status: "SKIPPED" },
  committed: { status: "COMMITTED" }
};

export async function jobDetail(job: JobRecord, options: { filter?: string; offset?: number; limit?: number } = {}): Promise<ImportJobDetail> {
  const where = { jobId: job.id, ...(FILTERS[options.filter ?? "all"] ?? {}) };
  const [rows, total] = await Promise.all([
    db.importRow.findMany({ where, orderBy: { line: "asc" }, skip: options.offset ?? 0, take: Math.min(options.limit ?? 200, 500) }),
    db.importRow.count({ where })
  ]);
  const [masters, products, deciders] = await Promise.all([
    db.masterProduct.findMany({ where: { id: { in: rows.map((row) => row.masterProductId).filter((id): id is string => !!id) } }, select: { id: true, name: true } }),
    db.product.findMany({ where: { id: { in: rows.map((row) => row.productId).filter((id): id is string => !!id) } }, select: { id: true, name: true } }),
    db.user.findMany({ where: { id: { in: rows.map((row) => row.decidedById).filter((id): id is string => !!id) } }, select: { id: true, name: true } })
  ]);
  const nameIn = (list: Array<{ id: string; name: string }>, id: string | null) => id ? list.find((item) => item.id === id)?.name ?? null : null;
  const items: ImportRowItem[] = rows.map((row) => ({
    id: row.id, line: row.line, status: row.status, problems: row.problems, action: row.action, raw: row.raw as Record<string, string>, data: (row.data ?? null) as Record<string, unknown> | null,
    masterProductId: row.masterProductId, masterName: nameIn(masters, row.masterProductId), productId: row.productId, productName: nameIn(products, row.productId),
    score: row.score, candidates: (row.candidates ?? []) as unknown as ImportCandidate[], decidedBy: nameIn(deciders, row.decidedById)
  }));
  return { job: await summaryOf(job), headers: job.headers, columnMap: (job.columnMap ?? {}) as Record<string, string>, fields: fieldsFor(job.kind), rows: items, total };
}

/**
 * Starts an import from an uploaded file. The same file is never imported twice into a branch: if it was committed
 * before, it is refused; if an import of it is still open, that one is resumed instead of starting another.
 */
export async function createJob(input: { user: AuthUser; organisationId: string; branchId: string; kind: ImportKind; fileName: string; content: Buffer }): Promise<{ job: JobRecord; resumed: boolean } | Response> {
  const fileHash = createHash("sha256").update(input.content).digest("hex");
  const earlier = await db.importJob.findFirst({ where: { branchId: input.branchId, kind: input.kind, fileHash, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" } });
  if (earlier?.status === "COMMITTED") return apiError(409, "IMPORT_ALREADY_DONE", `This file was already imported on ${earlier.committedAt!.toISOString().slice(0, 10)}. Importing it again would double the stock and balances.`, { jobId: earlier.id });
  if (earlier) return { job: earlier, resumed: true };

  const sheet = await readSheet(input.fileName, input.content);
  if ("error" in sheet) return apiError(400, "UNREADABLE_FILE", sheet.error);
  const columnMap = guessColumnMap(input.kind, sheet.headers);
  const job = await db.importJob.create({
    data: {
      organisationId: input.organisationId, branchId: input.branchId, kind: input.kind, fileName: input.fileName, fileHash, headers: sheet.headers, columnMap, rowCount: sheet.rows.length, createdById: input.user.id,
      rows: { create: sheet.rows.map((raw, index) => ({ line: index + 2, raw, status: "READY" as const })) }
    }
  });
  await db.auditLog.create({ data: { organisationId: input.organisationId, branchId: input.branchId, userId: input.user.id, action: "import.uploaded", entityType: "import", entityId: job.id, metadata: { kind: input.kind, fileName: input.fileName, rows: sheet.rows.length, assisted: input.user.role === "super-admin" } } });
  // When every required field found its column, check the rows straight away.
  if (IMPORT_FIELDS[input.kind].every((field) => !field.required || columnMap[field.key])) return { job: await applyMapping(job, columnMap, input.user), resumed: false };
  return { job, resumed: false };
}

/** Saves the column matching and checks every row against it. Earlier decisions are cleared, since the rows changed. */
export async function applyMapping(job: JobRecord, columnMap: Record<string, string>, user: AuthUser): Promise<JobRecord> {
  const rows = await db.importRow.findMany({ where: { jobId: job.id }, orderBy: { line: "asc" }, select: { id: true, line: true, raw: true } });
  const checked = await checkRows({ kind: job.kind, branchId: job.branchId, columnMap, rows: rows.map((row) => ({ line: row.line, raw: row.raw as Record<string, string> })) });
  await db.$transaction(async (tx) => {
    for (let index = 0; index < rows.length; index++) {
      const result = checked[index];
      await tx.importRow.update({
        where: { id: rows[index].id },
        data: { data: result.data as Prisma.InputJsonValue, status: result.status, problems: result.problems, action: result.action, masterProductId: result.masterProductId, productId: result.productId, score: result.score, candidates: (result.candidates ?? undefined) as Prisma.InputJsonValue | undefined, decidedById: null, decidedAt: null }
      });
    }
    await tx.importJob.update({ where: { id: job.id }, data: { columnMap, status: "REVIEW", lastError: null } });
  }, { timeout: 120_000 });
  await db.auditLog.create({ data: { organisationId: job.organisationId, branchId: job.branchId, userId: user.id, action: "import.checked", entityType: "import", entityId: job.id, metadata: { columnMap } } });
  return db.importJob.findUniqueOrThrow({ where: { id: job.id } });
}

/** A person settles rows: which medicine it is, a new shop item, or leave it out. Each decision records who made it. */
export async function decide(job: JobRecord, decisions: ImportDecision[], user: AuthUser): Promise<{ applied: number; errors: Array<{ rowId: string; error: string }> }> {
  const errors: Array<{ rowId: string; error: string }> = [];
  let applied = 0;
  for (const decision of decisions) {
    const row = await db.importRow.findFirst({ where: { id: decision.rowId, jobId: job.id } });
    if (!row || row.status === "COMMITTED" || (row.status === "INVALID" && decision.action !== "SKIP")) { errors.push({ rowId: decision.rowId, error: "This row cannot be changed" }); continue; }
    let outcome: { status: "READY" | "NEEDS_REVIEW" | "INVALID" | "SKIPPED"; problems: string[] };
    if (job.kind === "STOCK") {
      const checked = await checkDecision(row, decision, job.branchId);
      if ("error" in checked) { errors.push({ rowId: decision.rowId, error: checked.error }); continue; }
      outcome = checked;
    } else if (decision.action === "SKIP" || decision.action === "CREATE") {
      outcome = decision.action === "SKIP" ? { status: "SKIPPED", problems: ["Left out by the reviewer"] } : { status: "READY", problems: [] };
    } else { errors.push({ rowId: decision.rowId, error: "Unknown choice" }); continue; }
    await db.importRow.update({ where: { id: row.id }, data: { status: outcome.status, problems: outcome.problems, action: decision.action, masterProductId: decision.action === "MASTER" ? decision.masterProductId : null, productId: decision.action === "EXISTING" ? decision.productId : null, decidedById: user.id, decidedAt: new Date() } });
    applied++;
  }
  if (applied) await db.auditLog.create({ data: { organisationId: job.organisationId, branchId: job.branchId, userId: user.id, action: "import.rows_decided", entityType: "import", entityId: job.id, metadata: { decisions: decisions.length, applied } } });
  return { applied, errors };
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The rows that need fixing, with the original columns and what is wrong, to correct in Excel and upload again. */
export async function problemsCsv(job: JobRecord): Promise<string> {
  const rows = await db.importRow.findMany({ where: { jobId: job.id, status: { in: ["INVALID", "NEEDS_REVIEW", "SKIPPED"] } }, orderBy: { line: "asc" } });
  const lines = [["Line", "Status", "Problems", ...job.headers], ...rows.map((row) => [row.line, row.status.replace("_", " ").toLowerCase(), row.problems.join("; "), ...job.headers.map((header) => (row.raw as Record<string, string>)[header] ?? "")])];
  return "\uFEFF" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const EXAMPLES: Record<ImportKind, Record<string, string | number>> = {
  STOCK: { name: "Panadol 500mg", barcode: "8964000111222", company: "GSK", generic: "Paracetamol", packing: "10x10", batchNo: "PN2301", expiry: "31/03/2027", packs: 12, units: 4, costPrice: 82.5, retailPrice: 100, rack: "A-3" },
  CUSTOMERS: { name: "Ali Raza", phone: "0300-1234567", balance: 2350, since: "15/08/2026", creditLimit: 5000 },
  SUPPLIERS: { name: "Muller & Phipps", phone: "042-111222333", address: "Lahore", balance: 48200 }
};

/** A ready-to-fill Excel template: the headings on the first sheet, one example row, and a sheet explaining each column. */
export async function templateWorkbook(kind: ImportKind): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Pharmica";
  const fields = IMPORT_FIELDS[kind];
  const sheet = workbook.addWorksheet(KIND_LABELS[kind].split(" ")[0]);
  sheet.columns = fields.map((field) => ({ header: field.label, key: field.key, width: Math.max(14, field.label.length + 4) }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  // The example lives on the help sheet, so it can never be imported by mistake.
  const help = workbook.addWorksheet("How to fill");
  help.columns = [{ header: "Column", width: 30 }, { header: "Needed", width: 10 }, { header: "Example", width: 22 }, { header: "Notes", width: 70 }];
  help.getRow(1).font = { bold: true };
  for (const field of fields) help.addRow([field.label, field.required ? "Yes" : "", EXAMPLES[kind][field.key] ?? "", field.hint ?? ""]);
  help.addRow([]);
  help.addRow(["Fill the first sheet, one row per item. Keep the headings; extra columns are ignored. Dates may be 31/03/2027, 03/2027, or Mar-27. Only the first sheet is read."]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
