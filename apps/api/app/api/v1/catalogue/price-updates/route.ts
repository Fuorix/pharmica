import { apiError } from "../../../../../src/lib/api-response";
import { priceUpdates } from "../../../../../src/reports/reports";
import { OPTIONS_HANDLER, reportResponse, reportScope, withCors } from "../../../../../src/reports/route-helpers";

export const OPTIONS = OPTIONS_HANDLER;

/**
 * Official price changes (recent and scheduled) for medicines the branch stocks, with the shop price, so the owner
 * can follow the master price or keep a lower one (catalogue PATCH sets or clears the shop price).
 */
export async function GET(request: Request): Promise<Response> {
  const scope = await reportScope(request);
  if ("response" in scope) return withCors(scope.response, request);
  if (scope.branches.length !== 1) return withCors(apiError(400, "BRANCH_REQUIRED", "Choose one branch"), request);
  const days = Number(scope.params.get("days") ?? 30);
  return reportResponse(request, scope, { updates: await priceUpdates(scope.branches[0].id, { days: Number.isInteger(days) && days > 0 && days <= 365 ? days : 30 }) });
}
