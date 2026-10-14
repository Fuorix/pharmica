import { z } from "zod";
import { settleShopReports, shopReportGroups } from "../../../../../../src/admin/catalogue";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../../src/admin/http";
import { apiError } from "../../../../../../src/lib/api-response";
import { money, optionalTrimmed, parseBody } from "../../../../../../src/lib/validation";

const settleSchema = z.object({
  masterProductId: z.string().min(1),
  reportedPrice: money,
  action: z.enum(["publish", "dismiss"]),
  note: optionalTrimmed(300),
  effectiveFrom: z.iso.date().optional()
}).refine((body) => body.action === "publish" || body.note, { message: "Say why the reports are dismissed", path: ["note"] });

export const OPTIONS = OPTIONS_HANDLER;

/** The review queue of price changes reported by shops, grouped so one decision covers every shop. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  return json(request, { groups: await shopReportGroups() });
}

/** Publishes the reported price to every shop (as a SHOP_REPORT price), or dismisses the reports with a reason. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const body = await parseBody(request, settleSchema);
  if ("response" in body) return withCors(body.response, request);
  const result = await settleShopReports({ ...body.data, effectiveFrom: body.data.effectiveFrom ? new Date(`${body.data.effectiveFrom}T00:00:00+05:00`) : undefined, actorId: access.user.id });
  if (!result) return withCors(apiError(404, "NO_PENDING_REPORTS", "No pending reports for that medicine and price"), request);
  return json(request, result);
}
