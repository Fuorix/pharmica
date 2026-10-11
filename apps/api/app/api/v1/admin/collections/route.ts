import { json, OPTIONS_HANDLER, requireAdmin } from "../../../../../src/admin/http";
import { collections } from "../../../../../src/admin/tenants";

export const OPTIONS = OPTIONS_HANDLER;

/** Revenue, overdue and grace-mode shops, renewals coming up, churn, and payments waiting to be matched. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  return json(request, await collections());
}
