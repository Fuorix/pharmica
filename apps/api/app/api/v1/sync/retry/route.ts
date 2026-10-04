import { db } from "@pharmica/database/client";
import { canAccessScope, requireAuth } from "../../../../../src/auth/authorization";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request);
  if ("response" in access) return withCors(access.response, request);
  const body = await request.json().catch(() => null) as { idempotencyKey?: string } | null;
  if (!body?.idempotencyKey) return withCors(apiError(400, "OPERATION_REQUIRED", "Idempotency key is required"), request);
  const operation = await db.syncOperation.findUnique({ where: { idempotencyKey: body.idempotencyKey }, include: { device: true } });
  const branch = operation ? await db.branch.findUnique({ where: { id: operation.device.branchId } }) : null;
  if (!operation || !branch || !canAccessScope(access.user, branch.organisationId, operation.device.branchId)) return withCors(apiError(404, "OPERATION_NOT_FOUND", "Sync operation was not found"), request);
  const updated = await db.syncOperation.update({ where: { idempotencyKey: operation.idempotencyKey }, data: { status: "PENDING", errorMessage: null, nextAttemptAt: new Date(), retryCount: { increment: 1 } } });
  return withCors(Response.json({ operation: updated }, { headers: { "x-api-version": "v1" } }), request);
}
