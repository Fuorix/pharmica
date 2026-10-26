import type { LinkDeviceRequest, LinkDeviceResponse } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { isLockedOut, newDeviceSecret, recordAudit } from "../../../../../src/auth/authorization";
import { verifyCredential } from "../../../../../src/auth/credentials";
import { requireCloudSync } from "../../../../../src/billing/subscriptions";
import { parseCounterName } from "../../../../../src/devices/naming";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/**
 * Links a computer to a counter: the counter name (`K7P2QX-1`) plus the PIN of any staff member who may work at
 * that counter's branch. Returns a long-lived device token. A counter is linked to one computer at a time; the owner
 * unlinks it to move it to another computer. Wrong attempts count towards a lockout per counter.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as LinkDeviceRequest | null;
  const name = parseCounterName(body?.deviceName ?? "");
  const pin = body?.pin ?? "";
  if (!name || !/^\d{4,6}$/.test(pin)) return withCors(apiError(400, "INVALID_COUNTER", "Enter the counter name (like K7P2QX-1) and your PIN"), request);

  const lockKey = `link:${name}`;
  if (await isLockedOut(lockKey)) return withCors(apiError(429, "LOGIN_LOCKED", "Too many failed attempts. Try again in 15 minutes"), request);

  const device = await db.device.findUnique({ where: { name }, include: { branch: { include: { organisation: { select: { id: true, isActive: true } } } } } });
  const staff = device ? await db.user.findMany({
    where: { organisationId: device.branch.organisationId, isActive: true, role: { not: "SUPER_ADMIN" }, pinHash: { not: null }, OR: [{ branchId: null }, { branchId: device.branchId }] },
    orderBy: { createdAt: "asc" }
  }) : [];
  let user: (typeof staff)[number] | undefined;
  for (const candidate of staff) {
    if (await verifyCredential(pin, candidate.pinHash!)) { user = candidate; break; }
  }

  if (!device || !user) {
    await recordAudit({ organisationId: device?.branch.organisationId, branchId: device?.branchId, action: "auth.login_failed", entityType: "login", entityId: lockKey, metadata: { method: "counter-link" } });
    return withCors(apiError(401, "AUTHENTICATION_FAILED", "The counter name or PIN is not right"), request);
  }
  if (!device.isActive) return withCors(apiError(403, "DEVICE_DEACTIVATED", "This counter has been turned off by the owner"), request);
  if (device.secretHash) return withCors(apiError(409, "COUNTER_IN_USE", "This counter is already linked to another computer. The owner can unlink it under Staff & devices, or add a new counter"), request);

  // A new counter needs its first download, so it cannot be set up while cloud sync is paused.
  const paused = await requireCloudSync(device.branch.organisation);
  if (paused) return withCors(paused, request);

  const { secret, secretHash } = newDeviceSecret();
  // Only one computer can claim the counter: the update matches on the still-empty secret.
  const claimed = await db.device.updateMany({ where: { id: device.id, secretHash: null }, data: { secretHash, activatedAt: new Date(), lastSeenAt: new Date() } });
  if (claimed.count !== 1) return withCors(apiError(409, "COUNTER_IN_USE", "This counter is already linked to another computer. The owner can unlink it under Staff & devices, or add a new counter"), request);

  await recordAudit({ organisationId: device.branch.organisationId, branchId: device.branchId, userId: user.id, action: "device.linked", entityType: "device", entityId: device.id });
  const response: LinkDeviceResponse = {
    device: { id: device.id, name: device.name, branchId: device.branchId, branchName: device.branch.name },
    deviceToken: `${device.id}.${secret}`,
    userId: user.id
  };
  return withCors(Response.json(response, { status: 201, headers: { "x-api-version": "v1" } }), request);
}
