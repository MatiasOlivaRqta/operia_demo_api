import { describe, expect, it } from "vitest";
import { buildCashMovementWhere } from "./cash.service.js";

describe("buildCashMovementWhere", () => {
  it("uses Argentina inclusive calendar boundaries", () => {
    expect(
      buildCashMovementWhere("co", { from: "2026-10-09", to: "2026-10-09" }).createdAt,
    ).toEqual({
      gte: new Date("2026-10-09T03:00:00.000Z"),
      lt: new Date("2026-10-10T03:00:00.000Z"),
    });
  });
  it("defaults to 30 calendar days including today", () => {
    expect(buildCashMovementWhere("co", {}, new Date("2026-10-09T15:00:00Z")).createdAt).toEqual({
      gte: new Date("2026-09-10T03:00:00Z"),
      lt: new Date("2026-10-10T03:00:00Z"),
    });
  });
  it("does not constrain dates for a selected session", () => {
    expect(buildCashMovementWhere("co", { sessionId: "old" })).toEqual({
      companyId: "co",
      sessionId: "old",
    });
  });
});
