import type { PosSyncResult } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { authenticateDevice } from "../../../../../src/auth/authorization";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";
import { requireCloudSync } from "../../../../../src/billing/subscriptions";
import { processOperation } from "../../../../../src/pos/operations";

const MAX_BATCH = 100;

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/**
 * Uploads a counter's queued operations, oldest first. Authenticated by the device token, so the queue drains
 * even while the counter is locked. Each operation is applied once; the response reports each one's outcome.
 */
export async function POST(request: Request): Promise<Response> {
  const device = await authenticateDevice(request);
  if (!device) return withCors(apiError(401, "DEVICE_NOT_LINKED", "This counter is not linked or has been turned off"), request);
  // Billing never stops on the counter; only cloud sync pauses, and queued work waits for it.
  const paused = await requireCloudSync(device.branch.organisation);
  if (paused) return withCors(paused, request);

  const body = await request.json().catch(() => null) as { operations?: unknown } | null;
  if (!body || !Array.isArray(body.operations) || body.operations.length === 0) return withCors(apiError(400, "INVALID_SYNC_PUSH", "At least one operation is required"), request);
  if (body.operations.length > MAX_BATCH) return withCors(apiError(400, "SYNC_BATCH_TOO_LARGE", `Send at most ${MAX_BATCH} operations at a time`), request);

  const results: PosSyncResult[] = [];
  for (const operation of body.operations) results.push(await processOperation(device, operation));
  await db.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  return withCors(Response.json({ results }, { headers: { "x-api-version": "v1" } }), request);
}
