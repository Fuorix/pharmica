import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError } from "./api-response";
import { withCors } from "./cors";

describe("apiError", () => {
  it("uses the standard error envelope", async () => {
    const response = apiError(409, "INSUFFICIENT_STOCK", "Not enough stock", "req-1");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { code: "INSUFFICIENT_STOCK", message: "Not enough stock", requestId: "req-1" } });
  });
});

describe("withCors", () => {
  it("allows the apps to send idempotency keys and DELETE requests", () => {
    const request = new Request("http://localhost:4000/api/v1/sales", { headers: { origin: "http://localhost:3002" } });
    const response = withCors(new Response(null), request);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3002");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Idempotency-Key");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it("grants the hosted apps listed in PHARMICA_ALLOWED_ORIGINS", () => {
    vi.stubEnv("PHARMICA_ALLOWED_ORIGINS", " https://owner.example.com/, https://pos.example.com ");
    for (const origin of ["https://owner.example.com", "https://pos.example.com"]) {
      const request = new Request("https://api.example.com/api/v1/sales", { headers: { origin } });
      expect(withCors(new Response(null), request).headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
  });

  it("does not grant unknown origins", () => {
    const request = new Request("http://localhost:4000/api/v1/sales", { headers: { origin: "https://evil.example" } });
    expect(withCors(new Response(null), request).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows Vite fallback ports and 127.0.0.1", () => {
    for (const origin of ["http://localhost:3003", "http://127.0.0.1:3000"]) {
      const request = new Request("http://localhost:4000/api/v1/auth/login", { headers: { origin } });
      expect(withCors(new Response(null), request).headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
  });
});
