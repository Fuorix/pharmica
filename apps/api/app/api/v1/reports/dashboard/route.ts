import { dashboard } from "../../../../../src/reports/reports";
import { OPTIONS_HANDLER, reportResponse, reportScope, withCors } from "../../../../../src/reports/route-helpers";

export const OPTIONS = OPTIONS_HANDLER;

/** Today in Pakistan time, per branch and in total: sales, profit, cash in open drawers, stock alerts, and sync state. */
export async function GET(request: Request): Promise<Response> {
  const scope = await reportScope(request);
  if ("response" in scope) return withCors(scope.response, request);
  return reportResponse(request, scope, await dashboard(scope.branches));
}
