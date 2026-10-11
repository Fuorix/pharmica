import { db } from "@pharmica/database/client";
import { z } from "zod";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../../../src/admin/http";
import { tenantDetail } from "../../../../../../../src/admin/tenants";
import { requireRoomFor } from "../../../../../../../src/billing/subscriptions";
import { apiError } from "../../../../../../../src/lib/api-response";
import { optionalTrimmed, parseBody, trimmed } from "../../../../../../../src/lib/validation";

type Context = { params: Promise<{ id: string }> };
const schema = z.object({ name: trimmed(120), address: optionalTrimmed(200), phone: optionalTrimmed(30) });

export const OPTIONS = OPTIONS_HANDLER;

/** Opens another branch for a pharmacy, within its plan. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  if ("response" in body) return withCors(body.response, request);
  if (!await db.organisation.findUnique({ where: { id } })) return withCors(apiError(404, "TENANT_NOT_FOUND", "No such pharmacy"), request);
  const full = await requireRoomFor(id, "branches");
  if (full) return withCors(full, request);
  const branch = await db.branch.create({ data: { organisationId: id, name: body.data.name, address: body.data.address ?? null, phone: body.data.phone ?? null } });
  await db.auditLog.create({ data: { organisationId: id, branchId: branch.id, userId: access.user.id, action: "branch.created", entityType: "branch", entityId: branch.id } });
  return json(request, { tenant: await tenantDetail(id) }, 201);
}
