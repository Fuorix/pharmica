import { profitAndLoss } from "../../../../../src/reports/reports";
import { OPTIONS_HANDLER, reportResponse, reportScope, withCors } from "../../../../../src/reports/route-helpers";

export const OPTIONS = OPTIONS_HANDLER;

/** Revenue, cost of goods, gross profit, stock losses, expenses, and net profit for a period. */
export async function GET(request: Request): Promise<Response> {
  const scope = await reportScope(request, "accounting");
  if ("response" in scope) return withCors(scope.response, request);
  return reportResponse(request, scope, { profitAndLoss: await profitAndLoss(scope.branches, scope.period) });
}
