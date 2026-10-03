import { describe, expect, it } from "vitest";
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
  it("allows the POS to send idempotency keys and delete held bills", () => {
    const request = new Request("http://localhost:4000/api/v1/sales", { headers: { origin: "http://localhost:3002" } });
    const response = withCors(new Response(null), request);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3002");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Idempotency-Key");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
  });

  it("does not grant unknown origins", () => {
    const request = new Request("http://localhost:4000/api/v1/sales", { headers: { origin: "https://evil.example" } });
    expect(withCors(new Response(null), request).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
