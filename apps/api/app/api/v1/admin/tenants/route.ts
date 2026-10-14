import type { CreateTenantResponse } from "@pharmica/contracts";
import { z } from "zod";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../src/admin/http";
import { createTenant, tenantDetail, tenantList } from "../../../../../src/admin/tenants";
import { apiError } from "../../../../../src/lib/api-response";
import { optionalTrimmed, parseBody, trimmed } from "../../../../../src/lib/validation";

const createSchema = z.object({
  pharmacyName: trimmed(120),
  contactName: trimmed(120),
  phone: optionalTrimmed(30),
  city: optionalTrimmed(60),
  branchName: trimmed(120),
  branchAddress: optionalTrimmed(200),
  ownerName: trimmed(120),
  ownerLogin: z.string().trim().min(3).max(120).regex(/^[^\s]+$/, "No spaces"),
  planCode: trimmed(40),
  period: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]).optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  counters: z.number().int().min(0).max(20).optional()
});

export const OPTIONS = OPTIONS_HANDLER;

export async function GET(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const query = new URL(request.url).searchParams.get("q")?.trim() || null;
  return json(request, { tenants: await tenantList(query) });
}

/** Onboards a pharmacy in one step. The owner temporary password is returned once and never stored in clear. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const body = await parseBody(request, createSchema);
  if ("response" in body) return withCors(body.response, request);
  const created = await createTenant(body.data, access.user.id);
  if ("error" in created) return withCors(apiError(400, "TENANT_NOT_CREATED", created.error ?? "The pharmacy could not be created"), request);
  const response: CreateTenantResponse = { tenant: (await tenantDetail(created.organisationId))!, temporaryPassword: created.temporaryPassword };
  return json(request, response, 201);
}
