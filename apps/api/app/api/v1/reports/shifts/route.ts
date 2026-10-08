import { shiftHistory } from "../../../../../src/reports/reports";
import { OPTIONS_HANDLER, reportResponse, reportScope, withCors } from "../../../../../src/reports/route-helpers";

export const OPTIONS = OPTIONS_HANDLER;

/** Shifts opened in a period, with who worked them, takings, and cash over or short at closing. */
export async function GET(request: Request): Promise<Response> {
  const scope = await reportScope(request);
  if ("response" in scope) return withCors(scope.response, request);
  return reportResponse(request, scope, { shifts: await shiftHistory(scope.branches, scope.period) });
}
