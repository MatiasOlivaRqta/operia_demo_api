import { describe, expect, it } from "vitest";
import { settlementStatus } from "./settlement-status.js";

describe("settlementStatus", () => {
  it("returns PENDING when nothing has been paid", () => {
    expect(settlementStatus(18_420, 0)).toBe("PENDING");
  });

  it("returns PARTIAL when some but not all of the total has been paid", () => {
    expect(settlementStatus(18_420, 10_000)).toBe("PARTIAL");
  });

  it("returns COMPLETED when the exact total has been paid", () => {
    expect(settlementStatus(18_420, 18_420)).toBe("COMPLETED");
  });

  it("returns COMPLETED when payment exceeds the total", () => {
    expect(settlementStatus(18_420, 20_000)).toBe("COMPLETED");
  });
});
