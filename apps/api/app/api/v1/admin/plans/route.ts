import { db } from "@pharmica/database/client";
import { z } from "zod";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../src/admin/http";
import { toPlanSummary } from "../../../../../src/billing/subscriptions";
import { apiError } from "../../../../../src/lib/api-response";
import { money, parseBody } from "../../../../../src/lib/validation";

const FEATURES = ["reports", "accounting", "mobile"] as const;
const fields = {
  name: z.string().trim().min(1).max(60),
  monthlyPrice: money,
  quarterlyDiscountPercent: z.number().int().min(0).max(100),
  yearlyDiscountPercent: z.number().int().min(0).max(100),
  maxBranches: z.number().int().min(1).max(1000).nullable(),
  maxDevices: z.number().int().min(1).max(5000).nullable(),
  features: z.array(z.enum(FEATURES)),
  trialDays: z.number().int().min(0).max(90),
  isActive: z.boolean()
};
const createSchema = z.object({ code: z.string().trim().regex(/^[a-z0-9-]{2,30}$/, "Lower-case letters, numbers, and dashes"), ...fields });
const updateSchema = z.object({ id: z.string().min(1), ...fields }).partial().required({ id: true });

export const OPTIONS = OPTIONS_HANDLER;

export async function GET(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const plans = await db.plan.findMany({ orderBy: { monthlyPrice: "asc" }, include: { _count: { select: { subscriptions: true } } } });
  return json(request, { plans: plans.map((plan) => ({ ...toPlanSummary(plan), subscriptions: plan._count.subscriptions })) });
}

export async function POST(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const body = await parseBody(request, createSchema);
  if ("response" in body) return withCors(body.response, request);
  if (await db.plan.findUnique({ where: { code: body.data.code } })) return withCors(apiError(409, "PLAN_EXISTS", "A plan with that code exists"), request);
  const plan = await db.plan.create({ data: body.data });
  await db.auditLog.create({ data: { userId: access.user.id, action: "plan.created", entityType: "plan", entityId: plan.id, metadata: body.data } });
  return json(request, { plan: toPlanSummary(plan) }, 201);
}

/** Price changes apply to invoices issued from now on; open invoices keep the price they were issued at. */
export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const body = await parseBody(request, updateSchema);
  if ("response" in body) return withCors(body.response, request);
  const { id, ...change } = body.data;
  if (!await db.plan.findUnique({ where: { id } })) return withCors(apiError(404, "PLAN_NOT_FOUND", "No such plan"), request);
  const plan = await db.plan.update({ where: { id }, data: change });
  await db.auditLog.create({ data: { userId: access.user.id, action: "plan.updated", entityType: "plan", entityId: plan.id, metadata: change } });
  return json(request, { plan: toPlanSummary(plan) });
}
