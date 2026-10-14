import { db } from "@pharmica/database/client";
import { authenticateDevice } from "../../../../../src/auth/authorization";
import { masterSearchWhere, rankMatches, toMasterSummary } from "../../../../../src/catalogue/catalogue";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";
import { requireCloudSync } from "../../../../../src/billing/subscriptions";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/**
 * Master-list lookup for receiving stock at a counter (needs the internet): by scanned barcode or by name, salt,
 * or company. Only medicines the branch does not stock yet are returned; stocked ones are in the snapshot.
 */
export async function GET(request: Request): Promise<Response> {
  const device = await authenticateDevice(request);
  if (!device) return withCors(apiError(401, "DEVICE_NOT_ACTIVATED", "This POS device is not activated or has been deactivated"), request);
  // Billing never stops on the counter; only cloud sync pauses, and queued work waits for it.
  const paused = await requireCloudSync(device.branch.organisation);
  if (paused) return withCors(paused, request);
  const query = new URL(request.url).searchParams.get("q")?.trim();
  if (!query || query.length < 2) return withCors(Response.json({ products: [] }, { headers: { "x-api-version": "v1" } }), request);

  const products = await db.masterProduct.findMany({ where: { AND: [masterSearchWhere(query), { products: { none: { branchId: device.branchId } } }] }, orderBy: { name: "asc" }, take: 20 });
  return withCors(Response.json({ products: rankMatches(products.map(toMasterSummary), query) }, { headers: { "x-api-version": "v1" } }), request);
}
