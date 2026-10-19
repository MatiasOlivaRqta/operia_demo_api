import { describe, expect, it } from "vitest";
import { formatCuit, isValidCuit, normalizeCuit } from "./cuit.js";

describe("CUIT", () => {
  it("validates the check digit and formats normalized values", () => {
    expect(isValidCuit("30-71458963-2")).toBe(true);
    expect(normalizeCuit("30-71458963-2")).toBe("30714589632");
    expect(formatCuit("30714589632")).toBe("30-71458963-2");
  });

  it("rejects an invalid check digit, length, and non-numeric values", () => {
    expect(isValidCuit("30-71458963-1")).toBe(false);
    expect(isValidCuit("3071458963")).toBe(false);
    expect(isValidCuit("30-7145896A-2")).toBe(false);
  });
});
