import { afterEach, describe, expect, it, vi } from "vitest";
import { expiredSessionCookie, sessionCookie } from "./session";

const expires = new Date("2026-11-01T00:00:00.000Z");

describe("session cookie", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("is Lax, and Secure in production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(sessionCookie("t", expires)).toContain("SameSite=Lax");
    expect(sessionCookie("t", expires)).not.toContain("Secure");
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookie("t", expires)).toContain("SameSite=Lax; Secure");
  });

  it("can be sent across sites for a test deployment on unrelated hosts", () => {
    vi.stubEnv("SESSION_COOKIE_SAMESITE", "None");
    expect(sessionCookie("t", expires)).toContain("SameSite=None; Secure");
    // Signing out must use the same attributes, or the browser keeps the old cookie.
    expect(expiredSessionCookie()).toContain("SameSite=None; Secure");
  });
});
