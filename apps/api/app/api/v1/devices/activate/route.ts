import type { ActivateDeviceRequest, ActivateDeviceResponse } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { newDeviceSecret, recordAudit } from "../../../../../src/auth/authorization";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";
import { requireCloudSync } from "../../../../../src/billing/subscriptions";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** One-time POS activation: exchanges the owner-issued code for a long-lived device token. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as ActivateDeviceRequest | null;
  const code = body?.activationCode?.trim().toUpperCase();
  if (!code) return withCors(apiError(400, "ACTIVATION_CODE_REQUIRED", "An activation code is required"), request);

  const device = await db.device.findUnique({ where: { activationCode: code }, include: { branch: { include: { organisation: { select: { id: true, isActive: true } } } } } });
  if (!device) return withCors(apiError(404, "ACTIVATION_CODE_INVALID", "This activation code is not valid"), request);
  if (!device.isActive) return withCors(apiError(403, "DEVICE_DEACTIVATED", "This device has been deactivated by the owner"), request);
  if (device.secretHash) return withCors(apiError(409, "DEVICE_ALREADY_ACTIVATED", "This code was already used. Ask the owner to reset the device activation"), request);

  // A new counter needs its first download, so it cannot be set up while cloud sync is paused.
  const paused = await requireCloudSync(device.branch.organisation);
  if (paused) return withCors(paused, request);

  const { secret, secretHash } = newDeviceSecret();
  // Only one caller can claim the code: the update matches on the still-empty secret.
  const claimed = await db.device.updateMany({ where: { id: device.id, secretHash: null }, data: { secretHash, activatedAt: new Date(), lastSeenAt: new Date() } });
  if (claimed.count !== 1) return withCors(apiError(409, "DEVICE_ALREADY_ACTIVATED", "This code was already used. Ask the owner to reset the device activation"), request);

  await recordAudit({ organisationId: device.branch.organisationId, branchId: device.branchId, action: "device.activated_on_pos", entityType: "device", entityId: device.id });
  const response: ActivateDeviceResponse = {
    device: { id: device.id, name: device.name, branchId: device.branchId, branchName: device.branch.name },
    deviceToken: `${device.id}.${secret}`
  };
  return withCors(Response.json(response, { status: 201, headers: { "x-api-version": "v1" } }), request);
}
