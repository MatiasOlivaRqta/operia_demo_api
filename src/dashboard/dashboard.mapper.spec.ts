import { describe, expect, it } from "vitest";
import { mapDashboardActivityRow } from "./dashboard.mapper.js";

describe("mapDashboardActivityRow", () => {
  it.each(["PENDING", "PARTIAL", "COMPLETED", "CANCELLED"] as const)(
    "maps document status %s",
    (status) => {
      expect(
        mapDashboardActivityRow({
          kind: "document",
          id: "document-id",
          occurredAt: new Date("2026-10-15T02:30:00.000Z"),
          reference: "0001-00000001",
          counterparty: "Cliente",
          amountCents: 1_500n,
          quantity: null,
          status,
          refId: "document-id",
        }).status,
      ).toBe(status);
    },
  );

  it("maps a cancelled document without changing the timestamp's instant", () => {
    expect(
      mapDashboardActivityRow({
        kind: "document",
        id: "document-id",
        occurredAt: new Date("2026-10-15T02:30:00.000Z"),
        reference: "0001-00000001",
        counterparty: "Cliente",
        amountCents: 1_500n,
        quantity: null,
        status: "CANCELLED",
        refId: "document-id",
      }),
    ).toEqual({
      kind: "document",
      id: "document-id",
      occurredAt: "2026-10-14T23:30:00.000-03:00",
      reference: "0001-00000001",
      counterparty: "Cliente",
      amountCents: 1_500,
      status: "CANCELLED",
      refId: "document-id",
    });
  });

  it("maps stock movements to quantity and product refId", () => {
    expect(
      mapDashboardActivityRow({
        kind: "stock_movement",
        id: "movement-id",
        occurredAt: new Date("2026-10-14T03:00:00.000Z"),
        reference: "AJ-001",
        counterparty: "Producto",
        amountCents: null,
        quantity: 4n,
        status: "AJUSTE",
        refId: "product-id",
      }),
    ).toMatchObject({
      kind: "stock_movement",
      occurredAt: "2026-10-14T00:00:00.000-03:00",
      quantity: 4,
      status: "AJUSTE",
      refId: "product-id",
    });
  });

  it("maps collections to the cash movement reference", () => {
    expect(
      mapDashboardActivityRow({
        kind: "collection",
        id: "cash-movement-id",
        occurredAt: new Date("2026-10-14T15:00:00.000Z"),
        reference: "R-0001-00000001",
        counterparty: "Cliente",
        amountCents: 2_500n,
        quantity: null,
        status: "COLLECTED",
        refId: "cash-movement-id",
      }),
    ).toMatchObject({
      kind: "collection",
      reference: "R-0001-00000001",
      amountCents: 2_500,
      status: "COLLECTED",
      refId: "cash-movement-id",
    });
  });

  it("rejects amounts beyond the safe integer range", () => {
    expect(() =>
      mapDashboardActivityRow({
        kind: "collection",
        id: "movement-id",
        occurredAt: new Date(),
        reference: "R-1",
        counterparty: "Cliente",
        amountCents: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        quantity: null,
        status: "COLLECTED",
        refId: "movement-id",
      }),
    ).toThrow(RangeError);
  });
});
