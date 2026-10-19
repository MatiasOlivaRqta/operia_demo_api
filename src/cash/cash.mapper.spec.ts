import { describe, expect, it } from "vitest";
import { mapCashMovement, type CashMovementRow } from "./cash.mapper.js";

describe("mapCashMovement", () => {
  it("exposes readable enums, Argentina time and nullable document number without companyId", () => {
    const row: CashMovementRow = {
      id: "m1",
      createdAt: new Date("2026-10-09T15:30:00Z"),
      type: "COBRO",
      customerId: "c1",
      customerName: "Cliente",
      receiptNumber: "R-1",
      documentNumber: null,
      paymentMethod: "CASH",
      amount: 120,
    };
    const dto = mapCashMovement(row);
    expect(dto).toMatchObject({
      type: "COBRO",
      paymentMethod: "CASH",
      documentNumber: null,
      occurredAt: "2026-10-09T12:30:00.000-03:00",
    });
    expect(dto).not.toHaveProperty("companyId");
    expect(dto.type).not.toBe("C");
  });
});
