import { describe, expect, it } from "vitest";
import { formatPesos } from "./pesos.js";

describe("formatPesos", () => {
  it.each([
    [0, "$0,00"],
    [1, "$0,01"],
    [99, "$0,99"],
    [100, "$1,00"],
    [284200, "$2.842,00"],
    [2_147_483_648, "$21.474.836,48"],
    [-1, "-$0,01"],
    [-284200, "-$2.842,00"],
    [Number.MAX_SAFE_INTEGER, "$90.071.992.547.409,91"],
    [900719925474099312345n, "$9.007.199.254.740.993.123,45"],
  ] as const)("formats %s exactly", (amount, formatted) => {
    expect(formatPesos(amount)).toBe(formatted);
  });

  it.each([0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects inexact number %s",
    (amount) => {
      expect(() => formatPesos(amount)).toThrow(RangeError);
    },
  );
});
