import { describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service.js";
import { CustomerAccountService } from "../customer-account/customer-account.service.js";
import type { SessionContext } from "../common/request-context.js";
import { DocumentsService } from "./documents.service.js";

const session: SessionContext = {
  companyId: "company",
  userId: "user",
  sessionId: "session",
  permissions: ["documents.read"],
};
const baseBalance: {
  id: string;
  internalNumber: string;
  createdAt: Date;
  totalCents: number;
  paidCents: number;
  pendingCents: number;
  customerId: string;
  status: "PENDING" | "PARTIAL" | "COMPLETED" | "CANCELLED";
} = {
  id: "doc",
  internalNumber: "0001-00000001",
  createdAt: new Date("2026-10-01T12:00:00Z"),
  totalCents: 100_000,
  paidCents: 0,
  pendingCents: 100_000,
  customerId: "customer",
  status: "PENDING",
};

function fixture(
  entries: {
    id: string;
    type: "PAYMENT_APPLIED" | "CREDIT_APPLIED";
    amount: number;
    createdAt: Date;
    cashMovement: {
      id: string;
      createdAt: Date;
      paymentMethod: "CASH" | "TRANSFER" | "CARD";
      receiptNumber: string;
    } | null;
  }[],
  balance: typeof baseBalance | null = baseBalance,
) {
  const findMany = vi.fn().mockResolvedValue(entries);
  const accountEntry = { findMany };
  const getDocumentBalance = vi.fn().mockResolvedValue(balance);
  const service = new DocumentsService(
    { accountEntry } as unknown as DatabaseService,
    { getDocumentBalance } as unknown as CustomerAccountService,
  );
  return { findMany, getDocumentBalance, service };
}

describe("DocumentsService.collections", () => {
  it("returns a cash collection with the receipt and payment method", async () => {
    const f = fixture(
      [
        {
          id: "entry-payment",
          type: "PAYMENT_APPLIED",
          amount: 60_000,
          createdAt: new Date("2026-10-09T14:59:00Z"),
          cashMovement: {
            id: "movement",
            createdAt: new Date("2026-10-09T15:00:00Z"),
            paymentMethod: "TRANSFER",
            receiptNumber: "R-0001-00000001",
          },
        },
      ],
      { ...baseBalance, paidCents: 60_000, pendingCents: 40_000, status: "PARTIAL" },
    );

    await expect(f.service.collections(session, "doc")).resolves.toEqual({
      items: [
        {
          kind: "PAYMENT",
          occurredAt: "2026-10-09T12:00:00.000-03:00",
          amountCents: 60_000,
          paymentMethod: "TRANSFER",
          receiptNumber: "R-0001-00000001",
          cashMovementId: "movement",
        },
      ],
      totalCents: 100_000,
      paidCents: 60_000,
      pendingCents: 40_000,
    });
    expect(f.getDocumentBalance).toHaveBeenCalledWith("company", "doc");
  });

  it("shows only this document's FIFO allocation from a payment split across documents", async () => {
    const f = fixture(
      [
        {
          id: "entry-payment",
          type: "PAYMENT_APPLIED",
          amount: 35_000,
          createdAt: new Date("2026-10-09T15:00:00Z"),
          cashMovement: {
            id: "shared-movement",
            createdAt: new Date("2026-10-09T15:00:00Z"),
            paymentMethod: "CASH",
            receiptNumber: "R-0001-00000002",
          },
        },
      ],
      { ...baseBalance, paidCents: 35_000, pendingCents: 65_000, status: "PARTIAL" },
    );

    const response = await f.service.collections(session, "doc");

    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.amountCents).toBe(35_000);
    expect(response.paidCents).toBe(35_000);
    expect(response.pendingCents).toBe(65_000);
  });

  it("shows an applied credit at the account entry time without receipt fields", async () => {
    const f = fixture(
      [
        {
          id: "entry-credit",
          type: "CREDIT_APPLIED",
          amount: 30_000,
          createdAt: new Date("2026-10-09T16:30:00Z"),
          cashMovement: null,
        },
      ],
      { ...baseBalance, paidCents: 30_000, pendingCents: 70_000, status: "PARTIAL" },
    );

    await expect(f.service.collections(session, "doc")).resolves.toMatchObject({
      items: [
        {
          kind: "CREDIT_APPLIED",
          occurredAt: "2026-10-09T13:30:00.000-03:00",
          amountCents: 30_000,
          paymentMethod: null,
          receiptNumber: null,
          cashMovementId: null,
        },
      ],
      paidCents: 30_000,
      pendingCents: 70_000,
    });
  });

  it("returns the full pending balance when no collections exist", async () => {
    const f = fixture([]);

    await expect(f.service.collections(session, "doc")).resolves.toEqual({
      items: [],
      totalCents: 100_000,
      paidCents: 0,
      pendingCents: 100_000,
    });
    expect(f.findMany).toHaveBeenCalledTimes(1);
  });

  it("returns no items or balance for a cancelled document", async () => {
    const f = fixture([], { ...baseBalance, paidCents: 0, pendingCents: 0, status: "CANCELLED" });

    await expect(f.service.collections(session, "doc")).resolves.toEqual({
      items: [],
      totalCents: 100_000,
      paidCents: 0,
      pendingCents: 0,
    });
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it("returns the same not found error for a missing or other-company document", async () => {
    const f = fixture([], null);

    await expect(f.service.collections(session, "foreign-doc")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: "No encontramos el comprobante de la empresa activa.",
    });
    expect(f.findMany).not.toHaveBeenCalled();
  });
});
