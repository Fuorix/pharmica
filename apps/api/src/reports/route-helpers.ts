import { requireAuth } from "../auth/authorization";
import { requireFeature } from "../billing/subscriptions";
import { corsOptions, withCors } from "../lib/cors";
import { parsePeriod, requireBranches, type Period, type ScopeBranch } from "./period";

/** Owner reports: signed-in owner (or Pharmica admin), the branches asked for, and the date range. */
export async function reportScope(request: Request, feature: "reports" | "accounting" = "reports"): Promise<{ branches: ScopeBranch[]; period: Period; params: URLSearchParams } | { response: Response }> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return access;
  const params = new URL(request.url).searchParams;
  const scope = await requireBranches(access.user, params);
  if ("response" in scope) return scope;
  // Reports pause when the subscription lapses, and accounting needs a plan that includes it. Support staff can always look.
  const organisationId = scope.branches[0]?.organisationId ?? access.user.organisationId;
  if (access.user.role !== "super-admin" && organisationId) {
    const blocked = await requireFeature(organisationId, feature);
    if (blocked) return { response: blocked };
  }
  const period = parsePeriod(params);
  if ("response" in period) return period;
  return { branches: scope.branches, period, params };
}

/** Every report states exactly which days and branches its numbers cover. */
export function reportResponse(request: Request, scope: { branches: ScopeBranch[]; period: Period }, body: object): Response {
  return withCors(Response.json({ from: scope.period.fromDay, to: scope.period.toDay, branches: scope.branches.map(({ id, name }) => ({ id, name })), ...body }, { headers: { "x-api-version": "v1" } }), request);
}

export { corsOptions as OPTIONS_HANDLER, withCors };
