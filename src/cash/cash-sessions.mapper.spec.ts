import { describe, expect, it } from "vitest";
import { mapCashSession, type CashSessionRow } from "./cash-sessions.mapper.js";

const open: CashSessionRow = {
  id: "cash",
  status: "OPEN",
  openedAt: new Date("2026-10-09T13:00:00Z"),
  openedBy: { name: "Ana", email: "ana@tests.invalid" },
  openingBalance: 100000,
  closedAt: null,
  declaredBalance: null,
  theoreticalBalance: null,
  difference: null,
  observation: null,
  closedBy: null,
};
const closed: CashSessionRow = {
  ...open,
  status: "CLOSED",
  closedAt: new Date("2026-10-09T21:00:00Z"),
  declaredBalance: 284000n,
  theoreticalBalance: 284200n,
  difference: -200n,
  observation: "Faltó vuelto",
  closedBy: { name: "Beatriz" },
};
describe("mapCashSession", () => {
  it("returns only public opening fields and Argentine dates", () => {
    expect(mapCashSession({ ...open, companyId: "private" } as CashSessionRow)).toEqual({
      id: "cash",
      status: "OPEN",
      openedAt: "2026-10-09T10:00:00.000-03:00",
      openedBy: { name: "Ana" },
      openingBalanceCents: 100000,
    });
    expect(mapCashSession(open)).not.toHaveProperty("openedBy.email");
  });
  it("maps the closed session, safe BigInts and closing identity", () => {
    expect(mapCashSession(closed)).toEqual({
      ...mapCashSession(open),
      status: "CLOSED",
      closedAt: "2026-10-09T18:00:00.000-03:00",
      declaredBalanceCents: 284000,
      theoreticalBalanceCents: 284200,
      differenceCents: -200,
      observation: "Faltó vuelto",
      closedBy: { name: "Beatriz" },
    });
    expect(mapCashSession({ ...closed, observation: null })).not.toHaveProperty("observation");
  });
  it.each(["declaredBalance", "theoreticalBalance", "difference"] as const)(
    "rejects unsafe %s with a generic error",
    (field) => {
      expect(() =>
        mapCashSession({ ...closed, [field]: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
      ).toThrow("No se pudieron calcular los importes de caja.");
    },
  );
  it("rejects an incomplete closed row and accepts safe zero balances", () => {
    expect(() => mapCashSession({ ...closed, closedBy: null })).toThrow();
    expect(mapCashSession({ ...closed, declaredBalance: 0n, difference: 0n }).status).toBe(
      "CLOSED",
    );
  });
});
