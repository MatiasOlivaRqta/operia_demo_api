import { describe, expect, it } from "vitest";
import {
  dashboardActivityItemSchema,
  dashboardActivityQuerySchema,
  dashboardSummarySchema,
} from "./dashboard.schemas.js";

describe("dashboard schemas", () => {
  it("defaults the activity limit and accepts the inclusive bounds", () => {
    expect(dashboardActivityQuerySchema.parse({})).toEqual({ limit: 10 });
    expect(dashboardActivityQuerySchema.parse({ limit: "1" })).toEqual({ limit: 1 });
    expect(dashboardActivityQuerySchema.parse({ limit: "20" })).toEqual({ limit: 20 });
  });

  it.each(["0", "21", "1.5", "abc"])("rejects invalid activity limit %s", (limit) => {
    expect(dashboardActivityQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it("rejects unknown activity query parameters", () => {
    expect(
      dashboardActivityQuerySchema.safeParse({ limit: "10", companyId: "other" }).success,
    ).toBe(false);
  });

  it("rejects fields that do not belong to an activity kind", () => {
    expect(
      dashboardActivityItemSchema.safeParse({
        kind: "collection",
        id: "movement-id",
        occurredAt: "2026-10-14T12:00:00.000-03:00",
        reference: "R-1",
        counterparty: "Cliente",
        amountCents: 100,
        quantity: 2,
        status: "COLLECTED",
        refId: "movement-id",
      }).success,
    ).toBe(false);
  });

  it("accepts branch-specific activity fields only", () => {
    expect(
      dashboardActivityItemSchema.parse({
        kind: "stock_movement",
        id: "movement-id",
        occurredAt: "2026-10-14T12:00:00.000-03:00",
        reference: "Ingreso",
        counterparty: "Producto",
        quantity: 3,
        status: "INGRESO",
        refId: "product-id",
      }),
    ).not.toHaveProperty("amountCents");
  });

  it.each(["PENDING", "PARTIAL", "COMPLETED", "CANCELLED"] as const)(
    "accepts %s document activity status",
    (status) => {
      expect(
        dashboardActivityItemSchema.safeParse({
          kind: "document",
          id: "document-id",
          occurredAt: "2026-10-14T12:00:00.000-03:00",
          reference: "0001-00000001",
          counterparty: "Cliente",
          amountCents: 100,
          status,
          refId: "document-id",
        }).success,
      ).toBe(true);
    },
  );

  it("requires integer cents and the complete summary contract", () => {
    expect(
      dashboardSummarySchema.safeParse({
        date: "2026-10-14",
        salesToday: { totalCents: 10, count: 1, previousDayTotalCents: 5 },
        collectionsToday: { totalCents: 5, count: 1 },
        receivables: { balanceCents: 5, customersWithBalance: 1 },
        lowStockCount: 2,
      }).success,
    ).toBe(true);
    expect(
      dashboardSummarySchema.safeParse({
        date: "2026-10-14",
        salesToday: { totalCents: 1.5, count: 1, previousDayTotalCents: 0 },
        collectionsToday: { totalCents: 0, count: 0 },
        receivables: { balanceCents: 0, customersWithBalance: 0 },
        lowStockCount: 0,
      }).success,
    ).toBe(false);
  });
});
