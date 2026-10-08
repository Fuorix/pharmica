import { recordAudit, requireAuth } from "../../../../src/auth/authorization";
import { EXPORT_ENTITIES, exportTable, plainRows, toCsv, type ExportEntity } from "../../../../src/export/export";
import { apiError } from "../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../src/lib/cors";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/**
 * The owner's own data, to keep or take elsewhere. Without `entity` it is every table as one JSON file;
 * with `entity` and `format=csv` it is that one table as a spreadsheet-ready CSV.
 */
export async function GET(request: Request): Promise<Response> {
  const access = await requireAuth(request, ["owner", "super-admin"]);
  if ("response" in access) return withCors(access.response, request);
  const params = new URL(request.url).searchParams;
  const organisationId = access.user.role === "super-admin" ? params.get("organisationId") : access.user.organisationId;
  if (!organisationId) return withCors(apiError(400, "ORGANISATION_REQUIRED", "An organisation is required"), request);

  const entity = params.get("entity");
  const format = params.get("format") ?? "json";
  if (entity && !EXPORT_ENTITIES.includes(entity as ExportEntity)) return withCors(apiError(400, "INVALID_ENTITY", `entity must be one of ${EXPORT_ENTITIES.join(", ")}`), request);
  if (format !== "json" && format !== "csv") return withCors(apiError(400, "INVALID_FORMAT", "format must be json or csv"), request);
  if (format === "csv" && !entity) return withCors(apiError(400, "ENTITY_REQUIRED", "Choose one table for a CSV export"), request);

  const stamp = new Date().toISOString().slice(0, 10);
  await recordAudit({ organisationId, userId: access.user.id, action: "data.exported", entityType: "Organisation", entityId: organisationId, metadata: { entity: entity ?? "all", format } });

  if (format === "csv") {
    const rows = await exportTable(organisationId, entity as ExportEntity);
    return withCors(new Response(toCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="pharmica-${entity}-${stamp}.csv"`, "x-api-version": "v1" } }), request);
  }

  const tables = entity ? [entity as ExportEntity] : [...EXPORT_ENTITIES];
  const data: Record<string, unknown> = { exportedAt: new Date().toISOString(), organisationId };
  for (const table of tables) data[table] = plainRows(await exportTable(organisationId, table));
  return withCors(new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="pharmica-${entity ?? "export"}-${stamp}.json"`, "x-api-version": "v1" } }), request);
}
