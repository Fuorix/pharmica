import { apiError } from "../../../../../src/lib/api-response";
import { stockHealth } from "../../../../../src/reports/reports";
import { OPTIONS_HANDLER, reportResponse, reportScope, withCors } from "../../../../../src/reports/route-helpers";

export const OPTIONS = OPTIONS_HANDLER;

/** Dead stock and reorder suggestions for one branch. `deadDays` (default 90) and `coverDays` (default 14) tune them. */
export async function GET(request: Request): Promise<Response> {
  const scope = await reportScope(request);
  if ("response" in scope) return withCors(scope.response, request);
  if (scope.branches.length !== 1) return withCors(apiError(400, "BRANCH_REQUIRED", "Choose one branch"), request);
  const number = (name: string, fallback: number) => {
    const value = Number(scope.params.get(name) ?? fallback);
    return Number.isInteger(value) && value > 0 && value <= 730 ? value : fallback;
  };
  return reportResponse(request, scope, { items: await stockHealth(scope.branches[0].id, { deadDays: number("deadDays", 90), coverDays: number("coverDays", 14) }) });
}
