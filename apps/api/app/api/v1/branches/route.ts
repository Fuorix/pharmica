import { db, type Prisma } from "@pharmica/database/client";
import { z } from "zod";
import { canAccessScope, recordAudit, requireAuth, requireBranch } from "../../../../src/auth/authorization";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";
import { parseBody } from "../../../../src/lib/validation";
import { branchSettings } from "../../../../src/reports/reports";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

const updateSchema = z.object({
  branchId: z.string().min(1),
  address: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  settings: z.object({
    receiptHeader: z.string().trim().max(300),
    receiptFooter: z.string().trim().max(300),
    nearExpiryDays: z.number().int().min(7).max(365),
    overdueDays: z.number().int().min(1).max(365),
    largeDiscountPercent: z.number().min(1).max(100)
  }).partial().optional()
});

type BranchRow = { id: string; name: string; address: string | null; phone: string | null; settings: Prisma.JsonValue | null };
const toBranch = (branch: BranchRow) => ({ id: branch.id, name: branch.name, address: branch.address, phone: branch.phone, settings: branchSettings(branch.settings) });

/** Branches the caller may work with: all of the organisation for owners, their own branch otherwise. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request);
  if ("response" in access) return withCors(access.response, request);

  const organisationId = new URL(request.url).searchParams.get("organisationId") ?? access.user.organisationId;
  if (!organisationId || !canAccessScope(access.user, organisationId)) return withCors(apiError(403, "FORBIDDEN", "Organisation access denied"), request);

  const branches = await db.branch.findMany({
    where: { organisationId, ...(access.user.role !== "super-admin" && access.user.branchId ? { id: access.user.branchId } : {}) },
    select: { id: true, name: true, address: true, phone: true, settings: true },
    orderBy: { name: "asc" }
  });
  return withCors(Response.json({ branches: branches.map(toBranch) }, { headers: { "x-api-version": "v1" } }), request);
}

/** Owner edits a branch's address, phone, receipt text, and alert windows. Settings not sent keep their value. */
export async function PATCH(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const body = await parseBody(request, updateSchema);
  if ("response" in body) return withCors(body.response, request);
  const scope = await requireBranch(access.user, body.data.branchId);
  if ("response" in scope) return withCors(scope.response, request);

  const { address, phone, settings } = body.data;
  const merged = settings ? { ...branchSettings(scope.branch.settings), ...settings } : undefined;
  const branch = await db.branch.update({
    where: { id: scope.branch.id },
    data: {
      ...(address !== undefined ? { address: address || null } : {}),
      ...(phone !== undefined ? { phone: phone || null } : {}),
      ...(merged ? { settings: merged as Prisma.InputJsonValue } : {})
    },
    select: { id: true, name: true, address: true, phone: true, settings: true }
  });
  await recordAudit({ organisationId: scope.branch.organisationId, branchId: branch.id, userId: access.user.id, action: "branch.settings_updated", entityType: "Branch", entityId: branch.id, metadata: { address, phone, settings } });
  return withCors(Response.json({ branch: toBranch(branch) }, { headers: { "x-api-version": "v1" } }), request);
}
