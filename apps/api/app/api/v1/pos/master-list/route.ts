import type { MasterListPage } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { authenticateDevice } from "../../../../../src/auth/authorization";
import { toMasterSummary } from "../../../../../src/catalogue/catalogue";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

const MAX_PAGE = 1000;

/** The cursor is the last product sent: its update time and id, so pages never skip or repeat a product. */
function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const updatedAt = new Date(at);
  return id && !Number.isNaN(updatedAt.getTime()) ? { updatedAt, id } : null;
}

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/**
 * The master medicine list for counters to keep offline, oldest change first. A counter stores \`nextCursor\` and
 * passes it as \`since\`, so after a restart or a dropped connection it only downloads what changed.
 */
export async function GET(request: Request): Promise<Response> {
  const device = await authenticateDevice(request);
  if (!device) return withCors(apiError(401, "DEVICE_NOT_ACTIVATED", "This POS device is not activated or has been deactivated"), request);
  const params = new URL(request.url).searchParams;
  const since = params.get("since");
  const after = since ? decodeCursor(since) : null;
  if (since && !after) return withCors(apiError(400, "INVALID_CURSOR", "The cursor is not valid"), request);
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(params.get("limit") ?? MAX_PAGE) || MAX_PAGE));

  const rows = await db.masterProduct.findMany({
    where: after ? { OR: [{ updatedAt: { gt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { gt: after.id } }] } : undefined,
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit + 1
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const body: MasterListPage = {
    products: page.map(toMasterSummary),
    nextCursor: last ? encodeCursor(last.updatedAt, last.id) : since,
    hasMore: rows.length > limit
  };
  return withCors(Response.json(body, { headers: { "x-api-version": "v1" } }), request);
}
