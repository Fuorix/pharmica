import { requireAuth } from "../../../../../../src/auth/authorization";
import { jobForUser, problemsCsv } from "../../../../../../src/imports/jobs";
import { corsOptions, withCors } from "../../../../../../src/lib/cors";

type Context = { params: Promise<{ id: string }> };

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** The rows that were left out or need a decision, as CSV with the reasons, to fix in Excel and upload again. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const job = await jobForUser(access.user, (await context.params).id);
  if (job instanceof Response) return withCors(job, request);
  const name = job.fileName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_");
  return withCors(new Response(await problemsCsv(job), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}-problems.csv"`, "x-api-version": "v1" } }), request);
}
