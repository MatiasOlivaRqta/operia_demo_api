import { describe, expect, it } from "vitest";
import { cashMovementQuerySchema } from "./cash.schemas.js";

describe("cashMovementQuerySchema", () => {
  it("validates real paired dates and inclusive ranges", () => {
    expect(
      cashMovementQuerySchema.safeParse({ from: "2026-02-31", to: "2026-03-01" }).success,
    ).toBe(false);
    expect(
      cashMovementQuerySchema.safeParse({ from: "2026-09-01", to: "2026-10-01" }).success,
    ).toBe(false);
    expect(
      cashMovementQuerySchema.safeParse({ from: "2026-09-10", to: "2026-10-09" }).success,
    ).toBe(true);
    expect(cashMovementQuerySchema.safeParse({ from: "2026-10-01" }).success).toBe(false);
  });
  it("rejects unknown keys, invalid methods and page sizes", () => {
    for (const value of [
      { sort: "id" },
      { paymentMethod: "CHEQUE" },
      { pageSize: 0 },
      { pageSize: 101 },
    ])
      expect(cashMovementQuerySchema.safeParse(value).success).toBe(false);
  });

  it("allows a historical range longer than 30 days when filtering one session", () => {
    expect(
      cashMovementQuerySchema.safeParse({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        from: "2026-01-01",
        to: "2026-10-09",
      }).success,
    ).toBe(true);
  });
});
