import { alerts } from "../../../../../src/reports/reports";
import { OPTIONS_HANDLER, reportResponse, reportScope, withCors } from "../../../../../src/reports/route-helpers";

export const OPTIONS = OPTIONS_HANDLER;

/** Suspicious or noteworthy counter activity for a period: voids, big discounts, deleted lines, drawer opens, and more. */
export async function GET(request: Request): Promise<Response> {
  const scope = await reportScope(request);
  if ("response" in scope) return withCors(scope.response, request);
  return reportResponse(request, scope, { alerts: await alerts(scope.branches, scope.period) });
}
