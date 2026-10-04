import { describe, expect, it } from "vitest";
import { hashCredential, verifyCredential } from "./credentials";

describe("credentials", () => {
  it("verifies the credential it hashed", async () => {
    const hash = await hashCredential("1234");
    expect(hash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expect(verifyCredential("1234", hash)).resolves.toBe(true);
  });

  it("rejects a wrong credential", async () => {
    const hash = await hashCredential("1234");
    await expect(verifyCredential("4321", hash)).resolves.toBe(false);
  });

  it("salts each hash", async () => {
    expect(await hashCredential("1234")).not.toBe(await hashCredential("1234"));
  });

  it("rejects a malformed hash", async () => {
    await expect(verifyCredential("1234", "not-a-hash")).resolves.toBe(false);
  });
});
