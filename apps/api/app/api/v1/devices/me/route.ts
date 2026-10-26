import type { DeviceUser } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { authenticateDevice } from "../../../../../src/auth/authorization";
import { toRoleName } from "../../../../../src/auth/session";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** The linked POS counter reads its own identity and the staff who may sign in on it with a PIN. */
export async function GET(request: Request): Promise<Response> {
  const device = await authenticateDevice(request);
  if (!device) return withCors(apiError(401, "DEVICE_NOT_LINKED", "This counter is not linked or has been turned off"), request);

  const users = await db.user.findMany({
    where: {
      organisationId: device.branch.organisationId,
      isActive: true,
      pinHash: { not: null },
      role: { in: ["OWNER", "CASHIER"] },
      OR: [{ branchId: null }, { branchId: device.branchId }]
    },
    select: { id: true, name: true, role: true },
    orderBy: { name: "asc" }
  });
  const staff: DeviceUser[] = users.map((user) => ({ id: user.id, name: user.name, role: toRoleName(user.role) }));

  return withCors(Response.json({
    device: { id: device.id, name: device.name, branchId: device.branchId, branchName: device.branch.name },
    users: staff
  }, { headers: { "x-api-version": "v1" } }), request);
}
