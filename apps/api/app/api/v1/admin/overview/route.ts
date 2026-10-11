import { json, OPTIONS_HANDLER, requireAdmin } from "../../../../../src/admin/http";
import { overview } from "../../../../../src/admin/tenants";

export const OPTIONS = OPTIONS_HANDLER;

/** The control room: tenants, subscriptions, revenue, and the work waiting for the team. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  return json(request, await overview());
}
