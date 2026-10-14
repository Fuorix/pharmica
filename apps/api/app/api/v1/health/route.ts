import type { HealthResponse } from "@pharmica/contracts";

export function GET(): Response {
  const payload: HealthResponse = {
    status: "ok",
    service: "pharmica-api",
    timestamp: new Date().toISOString()
  };

  return Response.json(payload, {
    headers: { "x-api-version": "v1" }
  });
}
