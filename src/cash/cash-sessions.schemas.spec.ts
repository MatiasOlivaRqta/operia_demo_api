import { describe, expect, it } from "vitest";
import {
  cashSessionIdSchema,
  openCashSessionSchema,
  closeCashSessionSchema,
} from "./cash-sessions.schemas.js";

describe("cash session schemas", () => {
  it("accepts opening bounds with only the opening balance", () => {
    for (const openingBalanceCents of [0, 2_147_483_647]) {
      expect(openCashSessionSchema.parse({ openingBalanceCents })).toEqual({ openingBalanceCents });
    }
  });
  it.each([-1, 0.5, 2_147_483_648, "100", null])(
    "rejects opening amount %s",
    (openingBalanceCents) => {
      expect(openCashSessionSchema.safeParse({ openingBalanceCents }).success).toBe(false);
    },
  );
  it("rejects operatorName, extra fields and invalid UUIDs", () => {
    expect(
      openCashSessionSchema.safeParse({ openingBalanceCents: 0, operatorName: "Ana" }).success,
    ).toBe(false);
    expect(
      openCashSessionSchema.safeParse({
        openingBalanceCents: 0,
        companyId: "other",
      }).success,
    ).toBe(false);
    expect(
      closeCashSessionSchema.safeParse({ declaredBalanceCents: 0, closedBy: "other" }).success,
    ).toBe(false);
    expect(cashSessionIdSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
    expect(
      cashSessionIdSchema.safeParse({ id: "b7486be5-837c-4a7b-aeda-843641e567e5" }).success,
    ).toBe(true);
  });
  it("accepts safe declared amounts, empty optional observation and trims", () => {
    expect(
      closeCashSessionSchema.parse({
        declaredBalanceCents: Number.MAX_SAFE_INTEGER,
        observation: " note ",
      }).observation,
    ).toBe("note");
    expect(
      closeCashSessionSchema.safeParse({ declaredBalanceCents: 0, observation: "   " }).success,
    ).toBe(true);
    expect(closeCashSessionSchema.safeParse({ declaredBalanceCents: 0 }).success).toBe(true);
  });
  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, "0"])(
    "rejects declared amount %s",
    (declaredBalanceCents) => {
      expect(closeCashSessionSchema.safeParse({ declaredBalanceCents }).success).toBe(false);
    },
  );
  it("limits the trimmed observation to 500 characters", () => {
    expect(
      closeCashSessionSchema.safeParse({ declaredBalanceCents: 0, observation: "a".repeat(500) })
        .success,
    ).toBe(true);
    expect(
      closeCashSessionSchema.safeParse({ declaredBalanceCents: 0, observation: "a".repeat(501) })
        .success,
    ).toBe(false);
  });
});
