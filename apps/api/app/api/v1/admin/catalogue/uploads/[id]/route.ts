import { z } from "zod";
import { reviewRow, settleUpload, uploadRows, uploadSummaries } from "../../../../../../../src/admin/catalogue";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../../../src/admin/http";
import { apiError } from "../../../../../../../src/lib/api-response";
import { optionalTrimmed, parseBody } from "../../../../../../../src/lib/validation";

type Context = { params: Promise<{ id: string }> };
const rowSchema = z.object({ rowId: z.string().min(1), approved: z.boolean().optional(), masterProductId: z.string().min(1).optional() });
const settleSchema = z.object({ action: z.enum(["publish", "reject"]), note: optionalTrimmed(300) });

export const OPTIONS = OPTIONS_HANDLER;

export async function GET(request: Request, context: Context): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const [upload] = await uploadSummaries({ id });
  if (!upload) return withCors(apiError(404, "UPLOAD_NOT_FOUND", "No such upload"), request);
  return json(request, { upload, rows: await uploadRows(id) });
}

/** Review one row: approve or skip it, or match it to a master entry by hand. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const body = await parseBody(request, rowSchema);
  if ("response" in body) return withCors(body.response, request);
  const result = await reviewRow(body.data);
  if ("error" in result) return withCors(apiError(400, "ROW_NOT_CHANGED", result.error ?? "The row could not be changed"), request);
  const [upload] = await uploadSummaries({ id });
  return json(request, { upload, rows: await uploadRows(id) });
}

/** Publishes the approved rows to every shop, or rejects the whole file. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const body = await parseBody(request, settleSchema);
  if ("response" in body) return withCors(body.response, request);
  const result = await settleUpload({ uploadId: id, action: body.data.action, note: body.data.note, actorId: access.user.id });
  if ("error" in result) return withCors(apiError(409, "UPLOAD_SETTLED", result.error ?? "This upload was already settled"), request);
  const [upload] = await uploadSummaries({ id });
  return json(request, { upload, published: result.published });
}
