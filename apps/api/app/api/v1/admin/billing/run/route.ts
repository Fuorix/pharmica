import { db } from "@pharmica/database/client";
import { json, OPTIONS_HANDLER, requireAdmin } from "../../../../../../src/admin/http";
import { refreshSubscription } from "../../../../../../src/billing/subscriptions";

export const OPTIONS = OPTIONS_HANDLER;

/**
 * The daily billing pass: brings every subscription up to date (status changes and renewal invoices). Subscriptions
 * also refresh on their own whenever a shop uses Pharmica, so this only catches shops that have gone quiet.
 * Safe to run any number of times. A scheduler can call it once a day.
 */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const subscriptions = await db.subscription.findMany({ select: { organisationId: true, status: true } });
  let changed = 0;
  for (const subscription of subscriptions) {
    const refreshed = await refreshSubscription(subscription.organisationId);
    if (refreshed && refreshed.status !== subscription.status) changed++;
  }
  await db.auditLog.create({ data: { userId: access.user.id, action: "billing.run", entityType: "billing", metadata: { subscriptions: subscriptions.length, changed } } });
  return json(request, { subscriptions: subscriptions.length, changed });
}
