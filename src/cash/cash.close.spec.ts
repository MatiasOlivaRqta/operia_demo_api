import { describe, expect, it } from "vitest";
import { calculateCashClose, isCashCloseObservationValid } from "./cash.close.js";

describe("calculateCashClose", () => {
  it.each([
    [284200, 0, false],
    [284000, -200, true],
    [284400, 200, true],
  ])("calculates declared %i", (declared, difference, observationRequired) => {
    expect(calculateCashClose({ openingBalance: 10000, cashCollected: 274200, declared })).toEqual({
      theoretical: 284200,
      difference,
      observationRequired,
    });
  });

  it("accepts zero and aggregates over 32 bits", () => {
    expect(calculateCashClose({ openingBalance: 0, cashCollected: 0, declared: 0 })).toEqual({
      theoretical: 0,
      difference: 0,
      observationRequired: false,
    });
    expect(
      calculateCashClose({
        openingBalance: 2_000_000_000,
        cashCollected: 2_000_000_000,
        declared: 4_000_000_000,
      }).theoretical,
    ).toBe(4_000_000_000);
  });

  it("requires non-whitespace observations only when there is a difference", () => {
    const close = calculateCashClose({ openingBalance: 100, cashCollected: 0, declared: 99 });
    for (const observation of [undefined, null, "", " \t\r\n "]) {
      expect(isCashCloseObservationValid(close, observation)).toBe(false);
    }
    expect(isCashCloseObservationValid(close, " Recuento pendiente ")).toBe(true);
    expect(
      isCashCloseObservationValid(
        calculateCashClose({ openingBalance: 100, cashCollected: 0, declared: 100 }),
        " ",
      ),
    ).toBe(true);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid input %s in every field",
    (invalid) => {
      for (const field of ["openingBalance", "cashCollected", "declared"]) {
        expect(() =>
          calculateCashClose({
            openingBalance: 0,
            cashCollected: 0,
            declared: 0,
            [field]: invalid,
          }),
        ).toThrow(RangeError);
      }
    },
  );

  it("rejects overflow while accepting the safe boundary", () => {
    expect(() =>
      calculateCashClose({
        openingBalance: 1,
        cashCollected: Number.MAX_SAFE_INTEGER,
        declared: 0,
      }),
    ).toThrow(RangeError);
    expect(
      calculateCashClose({ openingBalance: 0, cashCollected: Number.MAX_SAFE_INTEGER, declared: 0 })
        .difference,
    ).toBe(-Number.MAX_SAFE_INTEGER);
  });
});
