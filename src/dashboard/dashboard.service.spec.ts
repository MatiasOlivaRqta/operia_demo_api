import { describe, expect, it } from "vitest";
import { dashboardDayRanges } from "./dashboard.service.js";

describe("dashboardDayRanges", () => {
  it("keeps 23:30 Argentina in that day even when UTC is already tomorrow", () => {
    const ranges = dashboardDayRanges(new Date("2026-10-15T02:30:00.000Z"));
    expect(ranges.date).toBe("2026-10-14");
    expect(ranges.todayStart.toISOString()).toBe("2026-10-14T03:00:00.000Z");
    expect(ranges.todayEnd.toISOString()).toBe("2026-10-15T03:00:00.000Z");
    expect(ranges.previousDayStart.toISOString()).toBe("2026-10-13T03:00:00.000Z");
    expect(ranges.previousDayEnd.toISOString()).toBe("2026-10-14T03:00:00.000Z");
  });

  it("starts a new Argentina day at 00:00", () => {
    const ranges = dashboardDayRanges(new Date("2026-10-15T03:00:00.000Z"));
    expect(ranges.date).toBe("2026-10-15");
    expect(ranges.todayStart.toISOString()).toBe("2026-10-15T03:00:00.000Z");
    expect(ranges.todayEnd.toISOString()).toBe("2026-10-16T03:00:00.000Z");
  });
});
