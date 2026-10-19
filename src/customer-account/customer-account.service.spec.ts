import { describe, expect, it, vi } from "vitest";
import { Prisma } from "../generated/prisma/client.js";
import { DatabaseService } from "../database/database.service.js";
import { ApiException } from "../common/errors.js";
import {
  accountSafeInteger,
  CustomerAccountService,
  validateCreditApplication,
  type DocumentBalance,
} from "./customer-account.service.js";

const document: DocumentBalance = {
  id: "doc",
  customerId: "customer",
  status: "PARTIAL",
  internalNumber: "0001-00000001",
  createdAt: new Date("2026-10-09T12:00:00Z"),
  totalCents: 1000,
  paidCents: 200,
  pendingCents: 800,
};
describe("credit application rules", () => {
  it("accepts an exact or partial application", () => {
    expect(() => validateCreditApplication("customer", document, 800, 800)).not.toThrow();
    expect(() => validateCreditApplication("customer", document, 800, 1)).not.toThrow();
  });
  it.each([
    [document, 100, 200],
    [document, 1000, 801],
    [{ ...document, status: "CANCELLED" as const }, 1000, 100],
    [{ ...document, status: "COMPLETED" as const }, 1000, 100],
    [{ ...document, customerId: "other" }, 1000, 100],
    [{ ...document, pendingCents: 0 }, 1000, 100],
  ])("rejects insufficient credit, excess pending or invalid document", (doc, credit, amount) => {
    try {
      validateCreditApplication("customer", doc, credit, amount);
      throw new Error("Expected rejection");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApiException);
      if (error instanceof ApiException) {
        expect(error.getStatus()).toBe(422);
        expect(error.code).toBe("business_rule");
      }
    }
  });
  it("hides absent or foreign-company documents behind 404", () => {
    try {
      validateCreditApplication("customer", null, 1000, 100);
      throw new Error("Expected rejection");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApiException);
      if (error instanceof ApiException) expect(error.getStatus()).toBe(404);
    }
  });
  it("checks aggregate integer safety", () => {
    expect(accountSafeInteger(3_000_000_000n)).toBe(3_000_000_000);
    expect(accountSafeInteger(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => accountSafeInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });
});

describe("CustomerAccountService settlement status", () => {
  it.each([
    [300, "PARTIAL", 700],
    [1000, "COMPLETED", 0],
  ] as const)(
    "applies %i credit cents and saves %s status",
    async (amount, expectedStatus, pending) => {
      const raw = vi
        .fn()
        .mockResolvedValueOnce([{ id: "customer" }])
        .mockResolvedValueOnce([
          {
            id: "doc",
            internalNumber: document.internalNumber,
            createdAt: document.createdAt,
            totalCents: 1000,
            customerId: "customer",
            status: "PENDING",
            paidCents: 0n,
            pendingCents: 1000n,
          },
        ])
        .mockResolvedValueOnce([{ debt: 1000n, credit: 1000n }])
        .mockResolvedValueOnce([
          { id: "doc", totalCents: 1000n, paidCents: BigInt(amount), status: "PENDING" },
        ]);
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const create = vi.fn().mockResolvedValue({
        id: "entry",
        customerId: "customer",
        documentId: "doc",
        amount,
        createdAt: new Date("2026-10-09T15:00:00Z"),
      });
      const tx = {
        $queryRaw: raw,
        document: { updateMany },
        accountEntry: { create },
      };
      const database = {
        $transaction: vi.fn(async (work: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          work(tx as unknown as Prisma.TransactionClient),
        ),
      };
      const service = new CustomerAccountService(database as unknown as DatabaseService);
      const result = await service.applyCredit("company", "customer", {
        documentId: "doc",
        amountCents: amount,
      });
      expect(result.document.pendingCents).toBe(pending);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: "CREDIT_APPLIED" }) }),
      );
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: "doc", companyId: "company", customerId: "customer", status: "PENDING" },
        data: { status: expectedStatus },
      });
      expect(create.mock.invocationCallOrder[0]).toBeLessThan(
        updateMany.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("reads paid totals for all affected documents in one query and skips unchanged statuses", async () => {
    const raw = vi.fn().mockResolvedValue([
      { id: "complete", totalCents: 1000n, paidCents: 1000n, status: "PENDING" },
      { id: "partial", totalCents: 1000n, paidCents: 100n, status: "PENDING" },
      { id: "unchanged", totalCents: 1000n, paidCents: 1000n, status: "COMPLETED" },
      { id: "cancelled", totalCents: 1000n, paidCents: 0n, status: "CANCELLED" },
    ]);
    const updateMany = vi.fn();
    const service = new CustomerAccountService({} as DatabaseService);
    const tx = { $queryRaw: raw, document: { updateMany } } as unknown as Prisma.TransactionClient;
    await service.updateSettlementStatuses(tx, "company", "customer", [
      "complete",
      "partial",
      "unchanged",
      "cancelled",
    ]);
    expect(raw).toHaveBeenCalledTimes(1);
    expect((raw.mock.calls[0]![0] as Prisma.Sql).values).toContain("partial");
    expect((raw.mock.calls[0]![0] as Prisma.Sql).values).toContain("complete");
    expect((raw.mock.calls[0]![0] as Prisma.Sql).values).toContain("unchanged");
    expect((raw.mock.calls[0]![0] as Prisma.Sql).values).toContain("cancelled");
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "complete" }),
        data: { status: "COMPLETED" },
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "partial" }),
        data: { status: "PARTIAL" },
      }),
    );
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "cancelled" }) }),
    );
  });
});

describe("CustomerAccountService collection applications", () => {
  const occurredAt = new Date("2026-10-09T15:00:00Z");
  const movement = {
    id: "movement",
    receiptNumber: "R-1",
    paymentMethod: "TRANSFER" as const,
    createdAt: occurredAt,
    amount: 200000,
  };
  function fixture(
    rows: {
      type: "PAYMENT_APPLIED" | "CREDIT_GENERATED";
      amount: number;
      document: {
        id: string;
        internalNumber: string;
        status: "PENDING" | "PARTIAL" | "COMPLETED" | "CANCELLED";
      } | null;
    }[],
    found: typeof movement | null = movement,
  ) {
    const findFirst = vi.fn().mockResolvedValue(found);
    const findMany = vi.fn().mockResolvedValue(rows);
    const service = new CustomerAccountService({
      cashMovement: { findFirst },
      accountEntry: { findMany },
    } as unknown as DatabaseService);
    return { service, findFirst, findMany };
  }
  const payment = (documentId: string, number: string, amount: number) => ({
    type: "PAYMENT_APPLIED" as const,
    amount,
    document: { id: documentId, internalNumber: number, status: "PARTIAL" as const },
  });
  it("lists automatic allocation across several documents in ledger order", async () => {
    const f = fixture([payment("doc-1", "0001-1", 100000), payment("doc-2", "0001-2", 80000)]);
    await expect(
      f.service.getCollectionApplications("company", "customer", "movement"),
    ).resolves.toMatchObject({
      documents: [
        { documentId: "doc-1", documentNumber: "0001-1", amountCents: 100000, status: "PARTIAL" },
        { documentId: "doc-2", documentNumber: "0001-2", amountCents: 80000, status: "PARTIAL" },
      ],
      creditGeneratedCents: 0,
    });
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
  });
  it("includes surplus generated credit", async () => {
    const f = fixture([
      payment("doc-1", "0001-1", 184200),
      { type: "CREDIT_GENERATED", amount: 15800, document: null },
    ]);
    await expect(
      f.service.getCollectionApplications("company", "customer", "movement"),
    ).resolves.toMatchObject({
      documents: [{ amountCents: 184200 }],
      creditGeneratedCents: 15800,
    });
  });
  it("lists a single document allocation without surplus", async () => {
    const f = fixture([payment("doc-1", "0001-1", 200000)]);
    await expect(
      f.service.getCollectionApplications("company", "customer", "movement"),
    ).resolves.toMatchObject({
      documents: [{ documentId: "doc-1", amountCents: 200000 }],
      creditGeneratedCents: 0,
    });
  });
  it("returns an empty document list and full generated credit for on-account collections", async () => {
    const f = fixture([{ type: "CREDIT_GENERATED", amount: 200000, document: null }]);
    await expect(
      f.service.getCollectionApplications("company", "customer", "movement"),
    ).resolves.toMatchObject({
      documents: [],
      creditGeneratedCents: 200000,
    });
  });
  it.each(["missing", "other-customer", "other-company"])(
    "returns 404 for %s collection",
    async () => {
      const f = fixture([], null);
      await expect(
        f.service.getCollectionApplications("company", "customer", "movement"),
      ).rejects.toMatchObject({
        code: "not_found",
        status: 404,
      });
      expect(f.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "movement", companyId: "company", customerId: "customer", type: "COBRO" },
        }),
      );
    },
  );
});
