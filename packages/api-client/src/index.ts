import type { HealthResponse } from "@pharmica/contracts";

export function createApiClient(baseUrl: string) {
  return {
    async health(): Promise<HealthResponse> {
      const response = await fetch(`${baseUrl}/health`);
      if (!response.ok) throw new Error("API health request failed");
      return response.json() as Promise<HealthResponse>;
    }
  };
}
