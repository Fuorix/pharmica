import type { SyncIssue } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { z } from "zod";
import { recordAudit, requireAuth, requireBranch } from "../../../../../src/auth/authorization";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";
import { parseBody } from "../../../../../src/lib/validation";

const reviewSchema = z.object({ operationId: z.string().min(1), note: z.string().trim().max(300).optional() });
const money = (value: unknown) => `PKR ${Number(value ?? 0).toFixed(2)}`;

/** A one-line description of what the counter was doing. */
function summarise(payload: Prisma.JsonValue): string {
  const operation = payload as { type?: string; payload?: Record<string, unknown> } | null;
  const body = operation?.payload ?? {};
  switch (operation?.type) {
    case "sale": return `Receipt ${body.receiptNo}, ${money(body.total)}`;
    case "sale.void": return `Void of sale ${String(body.saleId).slice(0, 8)}: ${body.reason}`;
    case "sale.return": return `Return: ${body.reason}`;
    case "customer.payment": return `Credit repayment ${money(body.amount)}`;
    case "purchase.receive": return `Purchase from ${(body.supplier as { name?: string })?.name ?? "supplier"}${body.invoiceNumber ? ` (invoice ${body.invoiceNumber})` : ""}`;
    case "stock.adjust": return `Stock ${String(body.type).toLowerCase().replace("_", " ")}: ${body.reason}`;
    case "stock.count": return `Physical count: ${body.reason}`;
    case "customer.create": return `New customer ${body.name}`;
    default: return operation?.type ?? "Operation";
  }
}

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/**
 * Uploaded counter operations that need the owner: rejected ones, ones still being retried, and accepted ones
 * with flags (oversold stock, credit over limit, controlled drug without a prescription, ...).
 * \`state=open\` (default) hides reviewed ones; \`state=all\` shows everything.
 */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const params = new URL(request.url).searchParams;
  const scope = await requireBranch(access.user, params.get("branchId"));
  if ("response" in scope) return withCors(scope.response, request);

  const operations = await db.syncOperation.findMany({
    where: {
      branchId: scope.branch.id,
      OR: [{ status: { in: ["FAILED", "PENDING"] } }, { status: "APPLIED", flags: { isEmpty: false } }],
      ...(params.get("state") === "all" ? {} : { reviewedAt: null })
    },
    include: { device: { select: { name: true } } },
    orderBy: { processedAt: "desc" },
    take: 200
  });
  const userIds = [...new Set(operations.flatMap((operation) => [operation.userId, operation.reviewedById]).filter((id): id is string => !!id))];
  const users = new Map((await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]));

  const issues: SyncIssue[] = operations.map((operation) => ({
    id: operation.idempotencyKey,
    deviceId: operation.deviceId,
    deviceName: operation.device.name,
    type: operation.entityType,
    status: operation.status === "FAILED" ? "rejected" : operation.status === "PENDING" ? "retrying" : "flagged",
    flags: operation.flags,
    error: operation.errorMessage,
    occurredAt: operation.occurredAt?.toISOString() ?? null,
    processedAt: operation.processedAt?.toISOString() ?? null,
    userName: operation.userId ? users.get(operation.userId) ?? null : null,
    summary: summarise(operation.payload),
    reviewedAt: operation.reviewedAt?.toISOString() ?? null,
    reviewedBy: operation.reviewedById ? users.get(operation.reviewedById) ?? null : null,
    reviewNote: operation.reviewNote
  }));
  return withCors(Response.json({ issues }, { headers: { "x-api-version": "v1" } }), request);
}

/** The owner marks an issue as looked at, optionally with a note on what was done. */
export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const parsed = await parseBody(request, reviewSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  const operation = await db.syncOperation.findUnique({ where: { idempotencyKey: parsed.data.operationId } });
  if (!operation) return withCors(apiError(404, "ISSUE_NOT_FOUND", "That sync issue was not found"), request);
  const scope = await requireBranch(access.user, operation.branchId);
  if ("response" in scope) return withCors(scope.response, request);

  await db.syncOperation.update({ where: { idempotencyKey: operation.idempotencyKey }, data: { reviewedAt: new Date(), reviewedById: access.user.id, reviewNote: parsed.data.note || null } });
  await recordAudit({ organisationId: scope.branch.organisationId, branchId: operation.branchId, userId: access.user.id, action: "sync.issue_reviewed", entityType: "sync_operation", entityId: operation.idempotencyKey, metadata: { note: parsed.data.note } });
  return withCors(new Response(null, { status: 204 }), request);
}
