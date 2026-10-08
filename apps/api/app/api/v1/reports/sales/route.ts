import { apiError } from "../../../../../src/lib/api-response";
import { groupFacts, saleFacts, totalsOf, type GroupBy } from "../../../../../src/reports/facts";
import { OPTIONS_HANDLER, reportResponse, reportScope, withCors } from "../../../../../src/reports/route-helpers";

const GROUPS: GroupBy[] = ["day", "product", "company", "cashier", "payment", "branch"];

export const OPTIONS = OPTIONS_HANDLER;

/** Sales, discounts, returns, cost, and margin for a period, grouped by day, product, company, cashier, payment method, or branch. */
export async function GET(request: Request): Promise<Response> {
  const scope = await reportScope(request);
  if ("response" in scope) return withCors(scope.response, request);
  const groupBy = (scope.params.get("groupBy") ?? "day") as GroupBy;
  if (!GROUPS.includes(groupBy)) return withCors(apiError(400, "INVALID_GROUP", `groupBy must be one of ${GROUPS.join(", ")}`), request);
  const facts = await saleFacts(scope.branches.map((branch) => branch.id), scope.period);
  return reportResponse(request, scope, { groupBy, totals: totalsOf(facts), rows: groupFacts(facts, groupBy, new Map(scope.branches.map((branch) => [branch.id, branch.name]))) });
}
