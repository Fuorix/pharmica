import { db, type Prisma } from "@pharmica/database/client";
import { z } from "zod";
import { json, OPTIONS_HANDLER, requireAdmin, withCors } from "../../../../../../src/admin/http";
import { temporaryPassword, tenantDetail } from "../../../../../../src/admin/tenants";
import { hashCredential } from "../../../../../../src/auth/credentials";
import { revokeUserSessions } from "../../../../../../src/auth/session";
import { apiError } from "../../../../../../src/lib/api-response";
import { optionalTrimmed, parseBody } from "../../../../../../src/lib/validation";

type Context = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  contactName: optionalTrimmed(120),
  phone: optionalTrimmed(30),
  city: optionalTrimmed(60),
  /** Suspending signs out every user and stops cloud sync; counters keep billing. A reason is required either way. */
  isActive: z.boolean().optional(),
  reason: optionalTrimmed(300),
  migrationStatus: z.enum(["NOT_STARTED", "IN_PROGRESS", "DONE", "NOT_NEEDED"]).optional(),
  migrationNote: z.string().trim().max(500).optional(),
  /** Issues a new temporary password for an owner who is locked out. */
  resetPasswordFor: z.string().min(1).optional()
});

export const OPTIONS = OPTIONS_HANDLER;

export async function GET(request: Request, context: Context): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const detail = await tenantDetail((await context.params).id);
  if (!detail) return withCors(apiError(404, "TENANT_NOT_FOUND", "No such pharmacy"), request);
  return json(request, { tenant: detail });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const access = await requireAdmin(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const body = await parseBody(request, patchSchema);
  if ("response" in body) return withCors(body.response, request);
  const organisation = await db.organisation.findUnique({ where: { id } });
  if (!organisation) return withCors(apiError(404, "TENANT_NOT_FOUND", "No such pharmacy"), request);
  const change = body.data;
  if (change.isActive !== undefined && change.isActive !== organisation.isActive && !change.reason) return withCors(apiError(400, "REASON_REQUIRED", "Say why the pharmacy is being suspended or restored"), request);

  let password: string | null = null;
  if (change.resetPasswordFor) {
    const owner = await db.user.findFirst({ where: { id: change.resetPasswordFor, organisationId: id, role: "OWNER" } });
    if (!owner) return withCors(apiError(404, "USER_NOT_FOUND", "No such owner in this pharmacy"), request);
    password = temporaryPassword();
    await db.user.update({ where: { id: owner.id }, data: { credentialHash: await hashCredential(password), mustChangeCredential: true } });
    await revokeUserSessions(owner.id);
    await db.auditLog.create({ data: { organisationId: id, userId: access.user.id, action: "tenant.owner_password_reset", entityType: "user", entityId: owner.id } });
  }

  const onboarding = { ...(organisation.onboarding && typeof organisation.onboarding === "object" && !Array.isArray(organisation.onboarding) ? organisation.onboarding : {}) } as Record<string, unknown>;
  if (change.migrationStatus) onboarding.migrationStatus = change.migrationStatus;
  if (change.migrationNote !== undefined) onboarding.migrationNote = change.migrationNote || null;
  await db.organisation.update({
    where: { id },
    data: {
      ...(change.name ? { name: change.name } : {}),
      ...(change.contactName !== undefined ? { contactName: change.contactName ?? null } : {}),
      ...(change.phone !== undefined ? { phone: change.phone ?? null } : {}),
      ...(change.city !== undefined ? { city: change.city ?? null } : {}),
      ...(change.isActive !== undefined ? { isActive: change.isActive } : {}),
      onboarding: onboarding as Prisma.InputJsonValue
    }
  });
  if (change.isActive === false && organisation.isActive) {
    // Suspension signs everyone out at once; sessions are checked against the organisation on every request too.
    await db.session.updateMany({ where: { user: { organisationId: id }, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  const { resetPasswordFor: _reset, ...logged } = change;
  await db.auditLog.create({ data: { organisationId: id, userId: access.user.id, action: change.isActive === false && organisation.isActive ? "tenant.suspended" : change.isActive === true && !organisation.isActive ? "tenant.restored" : "tenant.updated", entityType: "organisation", entityId: id, metadata: logged } });
  return json(request, { tenant: await tenantDetail(id), ...(password ? { temporaryPassword: password } : {}) });
}
