import { db, type Prisma } from "@pharmica/database/client";
import { z } from "zod";
import { authenticateDevice } from "../../../../../src/auth/authorization";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";
import { parseBody } from "../../../../../src/lib/validation";

const count = z.number().int().nonnegative();
const when = z.iso.datetime({ offset: true }).nullable();
const diagnosticsSchema = z.object({
  appVersion: z.string().max(40),
  reportedAt: z.iso.datetime({ offset: true }),
  pending: count,
  failed: count,
  oldestPendingAt: when,
  lastSyncAt: when,
  lastSnapshotAt: when,
  consecutiveFailures: count,
  lastError: z.string().max(500).nullable(),
  masterProducts: count,
  localSales: count
});

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** A counter reports its sync health after each sync, so the owner and support can see a stuck queue. */
export async function POST(request: Request): Promise<Response> {
  const device = await authenticateDevice(request);
  if (!device) return withCors(apiError(401, "DEVICE_NOT_ACTIVATED", "This POS device is not activated or has been deactivated"), request);
  const parsed = await parseBody(request, diagnosticsSchema);
  if ("response" in parsed) return withCors(parsed.response, request);
  await db.device.update({ where: { id: device.id }, data: { diagnostics: parsed.data as Prisma.InputJsonValue, diagnosticsAt: new Date(), lastSeenAt: new Date() } });
  return withCors(new Response(null, { status: 204 }), request);
}
