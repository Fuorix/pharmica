import type { ExpenseItem } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { z } from "zod";
import { recordAudit, requireAuth, requireBranch } from "../../../../src/auth/authorization";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";
import { money, optionalTrimmed, parseBody, trimmed } from "../../../../src/lib/validation";
import { parsePeriod, pkDayStart, requireBranches } from "../../../../src/reports/period";
import { requireFeature } from "../../../../src/billing/subscriptions";

/** Expenses are part of accounting: paused with reports when the subscription lapses, and only on plans that include it. */
async function requireAccounting(role: string, organisationId: string | null | undefined): Promise<Response | null> {
  return role === "super-admin" || !organisationId ? null : requireFeature(organisationId, "accounting");
}

export function OPTIONS(request: Request): Response { return corsOptions(request); }

const createSchema = z.object({
  branchId: z.string().min(1).optional(),
  category: trimmed(60),
  amount: money.refine((value) => value > 0, "Amount must be more than zero"),
  paidFrom: z.enum(["cash", "bank"]).default("cash"),
  note: optionalTrimmed(300),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});
const deleteSchema = z.object({ id: z.string().min(1) });

type ExpenseRow = Prisma.ExpenseGetPayload<{ include: { user: { select: { name: true } } } }>;

function toItem(expense: ExpenseRow): ExpenseItem {
  return {
    id: expense.id,
    branchId: expense.branchId,
    category: expense.category,
    amount: Number(expense.amount),
    paidFrom: expense.paidFrom === "bank" ? "bank" : "cash",
    note: expense.note,
    spentAt: expense.spentAt.toISOString(),
    recordedBy: expense.user.name
  };
}

/** Shop running costs (rent, bills, wages, and so on) recorded in a period, newest first. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const params = new URL(request.url).searchParams;
  const scope = await requireBranches(access.user, params);
  if ("response" in scope) return withCors(scope.response, request);
  const blocked = await requireAccounting(access.user.role, scope.branches[0]?.organisationId ?? access.user.organisationId);
  if (blocked) return withCors(blocked, request);
  const period = parsePeriod(params);
  if ("response" in period) return withCors(period.response, request);

  const expenses = await db.expense.findMany({
    where: { branchId: { in: scope.branches.map((branch) => branch.id) }, spentAt: { gte: period.from, lt: period.to } },
    include: { user: { select: { name: true } } },
    orderBy: { spentAt: "desc" }
  });
  return withCors(Response.json({ expenses: expenses.map(toItem) }, { headers: { "x-api-version": "v1" } }), request);
}

/** Records an expense. Without a day it is dated now; with one it is dated midday of that day in Pakistan time. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const body = await parseBody(request, createSchema);
  if ("response" in body) return withCors(body.response, request);
  const scope = await requireBranch(access.user, body.data.branchId);
  if ("response" in scope) return withCors(scope.response, request);
  const blocked = await requireAccounting(access.user.role, scope.branch.organisationId);
  if (blocked) return withCors(blocked, request);

  const spentAt = body.data.day ? new Date(pkDayStart(body.data.day).getTime() + 12 * 3_600_000) : new Date();
  if (Number.isNaN(spentAt.getTime()) || spentAt.getTime() > Date.now() + 86_400_000) return withCors(apiError(400, "INVALID_DATE", "Expense date cannot be in the future"), request);

  const expense = await db.expense.create({
    data: { branchId: scope.branch.id, userId: access.user.id, category: body.data.category, amount: body.data.amount, paidFrom: body.data.paidFrom, note: body.data.note, spentAt },
    include: { user: { select: { name: true } } }
  });
  await recordAudit({ organisationId: scope.branch.organisationId, branchId: scope.branch.id, userId: access.user.id, action: "expense.recorded", entityType: "Expense", entityId: expense.id, metadata: { category: expense.category, amount: body.data.amount, paidFrom: expense.paidFrom } });
  return withCors(Response.json({ expense: toItem(expense) }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}

/** Removes an expense entered by mistake. The audit log keeps what it was. */
export async function DELETE(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const body = await parseBody(request, deleteSchema);
  if ("response" in body) return withCors(body.response, request);

  const expense = await db.expense.findUnique({ where: { id: body.data.id }, include: { branch: true } });
  if (!expense) return withCors(apiError(404, "NOT_FOUND", "Expense not found"), request);
  const scope = await requireBranch(access.user, expense.branchId);
  if ("response" in scope) return withCors(apiError(404, "NOT_FOUND", "Expense not found"), request);

  await db.expense.delete({ where: { id: expense.id } });
  await recordAudit({ organisationId: expense.branch.organisationId, branchId: expense.branchId, userId: access.user.id, action: "expense.deleted", entityType: "Expense", entityId: expense.id, metadata: { category: expense.category, amount: Number(expense.amount), paidFrom: expense.paidFrom, spentAt: expense.spentAt.toISOString() } });
  return withCors(Response.json({ deleted: true }, { headers: { "x-api-version": "v1" } }), request);
}
