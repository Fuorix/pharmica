import { db } from "@pharmica/database/client";
import { getSessionToken, recordAudit } from "../../../../../src/auth/authorization";
import { expiredSessionCookie, revokeSession } from "../../../../../src/auth/session";
import { corsOptions, withCors } from "../../../../../src/lib/cors";

export function OPTIONS(request: Request): Response {
  return corsOptions(request);
}

export async function POST(request: Request): Promise<Response> {
  const revoked = await revokeSession(getSessionToken(request));
  if (revoked) {
    const user = await db.user.findUnique({ where: { id: revoked.userId } });
    await recordAudit({ organisationId: user?.organisationId ?? undefined, userId: revoked.userId, action: "auth.logout", entityType: "user", entityId: revoked.userId });
  }

  const response = new Response(null, { status: 204 });
  response.headers.append("Set-Cookie", expiredSessionCookie());
  return withCors(response, request);
}
