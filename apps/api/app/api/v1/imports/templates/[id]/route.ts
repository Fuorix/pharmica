import type { ImportKind } from "@pharmica/contracts";
import { requireAuth } from "../../../../../../src/auth/authorization";
import { templateWorkbook } from "../../../../../../src/imports/jobs";
import { apiError } from "../../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../../src/lib/cors";

type Context = { params: Promise<{ id: string }> };
const KINDS: Record<string, ImportKind> = { stock: "STOCK", customers: "CUSTOMERS", suppliers: "SUPPLIERS" };

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** The Excel template for stock, customers, or suppliers. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const { id } = await context.params;
  const kind = KINDS[id];
  if (!kind) return withCors(apiError(404, "TEMPLATE_NOT_FOUND", "Templates: stock, customers, suppliers"), request);
  return withCors(new Response(new Uint8Array(await templateWorkbook(kind)), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="pharmica-${id}-template.xlsx"`, "x-api-version": "v1" } }), request);
}
