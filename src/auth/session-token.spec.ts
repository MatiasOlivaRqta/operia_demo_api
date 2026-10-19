import { describe, expect, it } from "vitest";
import { createSessionToken, hashSessionToken } from "./session-token.js";

describe("session token utilities", () => {
  it("creates unique URL-safe tokens with 32 bytes of entropy", () => {
    const first = createSessionToken();
    const second = createSessionToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(second).not.toBe(first);
  });

  it("hashes a token deterministically without returning the token", () => {
    const token = createSessionToken();
    const hash = hashSessionToken(token);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSessionToken(token)).toBe(hash);
    expect(hash).not.toBe(token);
  });
});
