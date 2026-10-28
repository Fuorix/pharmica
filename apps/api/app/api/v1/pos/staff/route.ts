import type { CreatePosStaffRequest } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { authenticateDevice, recordAudit } from "../../../../../src/auth/authorization";
import { hashCredential } from "../../../../../src/auth/credentials";
import { toRoleName } from "../../../../../src/auth/session";
import { requireCapability } from "../../../../../src/billing/subscriptions";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

const PIN_PATTERN = /^\d{4,6}$/;

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** First-time setup on a linked counter: creates a cashier for this counter's branch. The device token is the credential. */
export async function POST(request: Request): Promise<Response> {
  const device = await authenticateDevice(request);
  if (!device) return withCors(apiError(401, "DEVICE_NOT_LINKED", "This counter is not linked or has been turned off"), request);

  const body = await request.json().catch(() => null) as CreatePosStaffRequest | null;
  const name = body?.name?.trim() ?? "";
  const login = body?.login?.trim().toLowerCase() ?? "";
  const pin = body?.pin ?? "";
  if (!name || !login || !pin) return withCors(apiError(400, "INVALID_USER", "Name, login, and a PIN are required"), request);
  if (!PIN_PATTERN.test(pin)) return withCors(apiError(400, "INVALID_PIN", "PIN must be 4 to 6 digits"), request);
  const maxDiscountPercent = body?.maxDiscountPercent ?? 5;
  if (!Number.isInteger(maxDiscountPercent) || maxDiscountPercent < 0 || maxDiscountPercent > 100) {
    return withCors(apiError(400, "INVALID_DISCOUNT_LIMIT", "Discount limit must be a whole percent from 0 to 100"), request);
  }

  const blocked = await requireCapability(device.branch.organisationId, "manage");
  if (blocked) return withCors(blocked, request);

  if (await db.user.findUnique({ where: { login } })) return withCors(apiError(409, "USER_ALREADY_EXISTS", "A user with that login already exists"), request);

  const user = await db.user.create({
    data: {
      organisationId: device.branch.organisationId,
      branchId: device.branchId,
      name,
      login,
      pinHash: await hashCredential(pin),
      maxDiscountPercent,
      role: "CASHIER"
    },
    select: { id: true, organisationId: true, name: true, login: true, role: true, branchId: true, isActive: true, createdAt: true, pinHash: true, maxDiscountPercent: true }
  });
  await recordAudit({
    organisationId: device.branch.organisationId,
    branchId: device.branchId,
    action: "user.created",
    entityType: "user",
    entityId: user.id,
    metadata: { role: "cashier", deviceId: device.id }
  });
  const { pinHash, role, ...summary } = user;
  return withCors(Response.json({
    user: { ...summary, role: toRoleName(role), hasPin: pinHash != null, maxDiscountPercent }
  }, { status: 201, headers: { "x-api-version": "v1" } }), request);
}
