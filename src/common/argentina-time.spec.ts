import { describe, expect, it } from "vitest";
import {
  argentinaDayEndExclusive,
  argentinaDayStart,
  formatArgentinaDateTime,
  todayInArgentina,
  toArgentinaIso,
} from "./argentina-time.js";

describe("Argentina time helpers", () => {
  it.each([
    ["2026-10-10T11:05:00Z", "2026-10-10 08:05"],
    ["2026-10-10T03:00:00Z", "2026-10-10 00:00"],
    ["2026-10-10T02:05:00Z", "2026-10-09 23:05"],
  ])("formats %s in Argentina as %s", (instant, expected) => {
    expect(formatArgentinaDateTime(new Date(instant))).toBe(expected);
  });

  it("formats an instant with the Argentina offset", () => {
    expect(toArgentinaIso(new Date("2026-10-09T15:30:00Z"))).toBe("2026-10-09T12:30:00.000-03:00");
  });

  it("returns Argentina calendar day boundaries", () => {
    const start = argentinaDayStart("2026-10-09");
    const end = argentinaDayEndExclusive("2026-10-09");
    expect(toArgentinaIso(new Date(end.getTime() - 1))).toBe("2026-10-09T23:59:59.999-03:00");
    expect(toArgentinaIso(end)).toBe("2026-10-10T00:00:00.000-03:00");
    expect(start.toISOString()).toBe("2026-10-09T03:00:00.000Z");
  });

  it("does not depend on the process timezone", () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const utc = [
        toArgentinaIso(new Date("2026-10-09T15:30:00Z")),
        todayInArgentina(new Date("2026-10-09T02:30:00Z")),
      ];
      process.env.TZ = "Pacific/Honolulu";
      const other = [
        toArgentinaIso(new Date("2026-10-09T15:30:00Z")),
        todayInArgentina(new Date("2026-10-09T02:30:00Z")),
      ];
      expect(other).toEqual(utc);
      expect(utc[1]).toBe("2026-10-08");
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });
});
