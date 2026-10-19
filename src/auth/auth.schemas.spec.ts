import { describe, expect, it } from "vitest";
import { loginSchema } from "./auth.schemas.js";

describe("loginSchema", () => {
  it("accepts an email and a bounded password", () => {
    expect(loginSchema.safeParse({ email: "user@example.test", password: "secret" }).success).toBe(
      true,
    );
  });

  it("rejects malformed credentials and unknown properties", () => {
    expect(loginSchema.safeParse({ email: "invalid", password: "secret" }).success).toBe(false);
    expect(
      loginSchema.safeParse({ email: "user@example.test", password: "secret", companyId: "other" })
        .success,
    ).toBe(false);
  });
});
