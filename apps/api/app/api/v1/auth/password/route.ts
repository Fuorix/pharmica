import { db } from "@pharmica/database/client";
import { z } from "zod";
import { getSessionToken, recordAudit, requireAuth } from "../../../../../src/auth/authorization";
import { hashCredential, verifyCredential } from "../../../../../src/auth/credentials";
import { hashToken } from "../../../../../src/auth/session";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";
import { parseBody } from "../../../../../src/lib/validation";

const schema = z.object({ currentCredential: z.string().min(1), newCredential: z.string().min(8, "Use at least 8 characters").max(200) });

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** Changes the signed-in user's password. Required first thing for accounts opened with a temporary password. */
export async function POST(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"], { allowCredentialChange: true });
  if ("response" in access) return withCors(access.response, request);
  const body = await parseBody(request, schema);
  if ("response" in body) return withCors(body.response, request);

  const user = await db.user.findUniqueOrThrow({ where: { id: access.user.id } });
  if (!user.credentialHash || !await verifyCredential(body.data.currentCredential, user.credentialHash)) {
    await recordAudit({ organisationId: user.organisationId ?? undefined, userId: user.id, action: "auth.password_change_failed", entityType: "user", entityId: user.id });
    return withCors(apiError(400, "WRONG_CREDENTIAL", "The current password is not right"), request);
  }
  if (body.data.newCredential === body.data.currentCredential) return withCors(apiError(400, "SAME_CREDENTIAL", "Choose a password different from the current one"), request);

  const token = getSessionToken(request);
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { credentialHash: await hashCredential(body.data.newCredential), mustChangeCredential: false } }),
    // Every other session of this user is signed out; this one carries on.
    db.session.updateMany({ where: { userId: user.id, revokedAt: null, ...(token ? { tokenHash: { not: hashToken(token) } } : {}) }, data: { revokedAt: new Date() } })
  ]);
  await recordAudit({ organisationId: user.organisationId ?? undefined, userId: user.id, action: "auth.password_changed", entityType: "user", entityId: user.id });
  return withCors(Response.json({ changed: true }, { headers: { "x-api-version": "v1" } }), request);
}
