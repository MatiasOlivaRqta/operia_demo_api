import { describe, expect, it } from "vitest";
import {
  calculateDocumentTotal,
  calculateItemDiscount,
  calculateItemTax,
  percentOf,
  roundHalfUp,
} from "./money.js";

describe("money parity", () => {
  it("rounds half up for positive and negative values", () => {
    expect(roundHalfUp(1234.5)).toBe(1235);
    expect(roundHalfUp(-1234.5)).toBe(-1235);
    expect(roundHalfUp(12.5)).toBe(13);
    expect(roundHalfUp(-12.5)).toBe(-13);
  });

  it("rounds percentages to integer cents", () => {
    expect(percentOf(5, 10)).toBe(1);
    expect(percentOf(-5, 10)).toBe(-1);
  });

  it("rounds discount and tax per line and sums rounded line amounts", () => {
    const item = {
      discountRate: 10,
      quantity: 3,
      taxRate: 21,
      unitPriceCents: 5,
    };
    expect(calculateItemDiscount(item)).toBe(2);
    expect(calculateItemTax(item)).toBe(3);
    expect(calculateDocumentTotal([item])).toBe(16);
    expect(calculateDocumentTotal([{ ...item, discountRate: 100 }])).toBe(0);
  });
});
