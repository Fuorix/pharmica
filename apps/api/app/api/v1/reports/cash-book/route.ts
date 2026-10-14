import { cashBook } from "../../../../../src/reports/reports";
import { OPTIONS_HANDLER, reportResponse, reportScope, withCors } from "../../../../../src/reports/route-helpers";

export const OPTIONS = OPTIONS_HANDLER;

/** Cash in and out per day for a period. */
export async function GET(request: Request): Promise<Response> {
  const scope = await reportScope(request, "accounting");
  if ("response" in scope) return withCors(scope.response, request);
  return reportResponse(request, scope, { days: await cashBook(scope.branches, scope.period) });
}
