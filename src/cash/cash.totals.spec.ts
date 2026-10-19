import { describe, expect, it } from "vitest";
import { calculateCashTotals } from "./cash.service.js";

describe("calculateCashTotals", () => {
  it("computes net and theoretical cash with absent methods at zero", () => {
    expect(
      calculateCashTotals(100_000, [
        { paymentMethod: "CASH", amount: 184_200, count: 1 },
        { paymentMethod: "TRANSFER", amount: 300_000, count: 1 },
        { paymentMethod: "CARD", amount: 50_000, count: 1 },
      ]),
    ).toEqual({
      byMethod: { CASH: 184_200, TRANSFER: 300_000, CARD: 50_000 },
      netCollectedCents: 534_200,
      movementsCount: 3,
      theoreticalCashCents: 284_200,
    });
    expect(
      calculateCashTotals(100_000, [{ paymentMethod: "TRANSFER", amount: 300_000, count: 1 }]),
    ).toEqual({
      byMethod: { CASH: 0, TRANSFER: 300_000, CARD: 0 },
      netCollectedCents: 300_000,
      movementsCount: 1,
      theoreticalCashCents: 100_000,
    });
  });
  it("rejects aggregates outside the safe integer range", () => {
    expect(() =>
      calculateCashTotals(0, [
        { paymentMethod: "CASH", amount: Number.MAX_SAFE_INTEGER + 1, count: 1 },
      ]),
    ).toThrow();
  });
});
