import { db } from "@pharmica/database/client";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../../../src/admin/http";
import { supportView } from "../../../../../../../src/admin/tenants";
import { apiError } from "../../../../../../../src/lib/api-response";

type Context = { params: Promise<{ id: string }> };

export const OPTIONS = OPTIONS_HANDLER;

/** Counter health, stuck or flagged uploads, and the audit trail, so support never needs database access. Read-only. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  if (!await db.organisation.findUnique({ where: { id } })) return withCors(apiError(404, "TENANT_NOT_FOUND", "No such pharmacy"), request);
  const cursor = new URL(request.url).searchParams.get("cursor");
  return json(request, await supportView(id, cursor));
}
