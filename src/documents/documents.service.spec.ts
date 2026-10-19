import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "../generated/prisma/client.js";
import { DatabaseService } from "../database/database.service.js";
import { CustomerAccountService } from "../customer-account/customer-account.service.js";
import { documentDetailSelect } from "./document.mapper.js";
import { documentQuerySchema } from "./document.schemas.js";
import { DocumentsService } from "./documents.service.js";

const session = { companyId: "company", userId: "user", sessionId: "auth", permissions: [] };
const cancelled: Prisma.DocumentGetPayload<{ select: typeof documentDetailSelect }> = {
  id: "doc",
  companyId: "company",
  customerId: "customer",
  customerName: "Customer",
  status: "CANCELLED",
  internalNumber: "0001-00000001",
  pointOfSale: "0001",
  totalCents: 1000,
  createdAt: new Date("2026-10-09T12:00:00Z"),
  cancellationReason: "Devolución",
  requestFingerprint: "hash",
  items: [],
  _count: { items: 0 },
};
function fixture(hasImputations: boolean, status: "PENDING" | "PARTIAL" | "COMPLETED" = "PENDING") {
  const tx = {
    document: {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce({
          id: "doc",
          customerId: "customer",
          status,
          internalNumber: "0001-00000001",
        })
        .mockResolvedValue(cancelled),
      updateMany: vi.fn().mockResolvedValue({ count: status === "PENDING" ? 1 : 0 }),
    },
    stockMovement: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([{ id: "outgoing", productId: "product", quantity: -2 }])
        .mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
    },
    product: { update: vi.fn().mockResolvedValue({}) },
  };
  const database = {
    $transaction: vi.fn(async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      work(tx as unknown as Prisma.TransactionClient),
    ),
  };
  const account = {
    lockCustomer: vi.fn().mockResolvedValue(undefined),
    hasImputations: vi.fn().mockResolvedValue(hasImputations),
  };
  return {
    tx,
    account,
    service: new DocumentsService(
      database as unknown as DatabaseService,
      account as unknown as CustomerAccountService,
    ),
  };
}

describe("DocumentsService.cancel account protection", () => {
  it("checks imputations under the customer lock and leaves document and stock intact on conflict", async () => {
    const f = fixture(true);
    await expect(f.service.cancel(session, "doc", { reason: "Devolución" })).rejects.toMatchObject({
      code: "conflict",
      message: "El comprobante tiene cobros imputados y no se puede anular.",
    });
    expect(f.account.lockCustomer).toHaveBeenCalledWith(f.tx, "company", "customer");
    expect(f.account.hasImputations).toHaveBeenCalledWith("company", "doc", f.tx);
    expect(f.account.lockCustomer.mock.invocationCallOrder[0]).toBeLessThan(
      f.account.hasImputations.mock.invocationCallOrder[0]!,
    );
    expect(f.tx.document.updateMany).not.toHaveBeenCalled();
    expect(f.tx.product.update).not.toHaveBeenCalled();
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it("preserves cancellation and stock reversal for an unpaid document", async () => {
    const f = fixture(false);
    expect(await f.service.cancel(session, "doc", { reason: "Devolución" })).toMatchObject({
      status: "CANCELLED",
      cancelledBy: "Devolución",
    });
    expect(f.account.hasImputations.mock.invocationCallOrder[0]).toBeLessThan(
      f.tx.document.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(f.tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: "doc", companyId: "company", status: "PENDING" },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
    expect(f.tx.product.update).toHaveBeenCalledWith({
      where: { id_companyId: { id: "product", companyId: "company" } },
      data: { stockOnHand: { increment: 2 } },
    });
    expect(f.tx.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "REVERSION",
          quantity: 2,
          reversesMovementId: "outgoing",
          documentId: "doc",
        }),
      }),
    );
  });
  it.each(["PARTIAL", "COMPLETED"] as const)(
    "rejects cancellation of %s documents",
    async (status) => {
      const f = fixture(false, status);
      await expect(
        f.service.cancel(session, "doc", { reason: "Devolución" }),
      ).rejects.toMatchObject({
        code: "conflict",
        status: 409,
      });
      expect(f.tx.document.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "doc", companyId: "company", status: "PENDING" },
        }),
      );
      expect(f.tx.product.update).not.toHaveBeenCalled();
    },
  );
});

describe("DocumentsService.create status", () => {
  it("creates a document with PENDING status", async () => {
    const row: Prisma.DocumentGetPayload<{ select: typeof documentDetailSelect }> = {
      id: "pv-0001-00000001",
      companyId: "company",
      customerId: "customer",
      customerName: "Customer",
      status: "PENDING",
      internalNumber: "0001-00000001",
      pointOfSale: "0001",
      totalCents: 1000,
      createdAt: new Date("2026-10-09T12:00:00Z"),
      cancellationReason: null,
      requestFingerprint: "hash",
      items: [],
      _count: { items: 0 },
    };
    const tx = {
      customer: {
        findFirst: vi.fn().mockResolvedValue({ id: "customer", commercialName: "Customer" }),
      },
      product: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "product", name: "Product", sku: "SKU", status: "ACTIVE", stockOnHand: 2 },
          ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ last_number: 1 }]),
      document: {
        create: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(row),
      },
      stockMovement: { create: vi.fn().mockResolvedValue({}) },
    };
    const database = {
      document: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        work(tx as unknown as Prisma.TransactionClient),
      ),
    };
    const service = new DocumentsService(
      database as unknown as DatabaseService,
      {} as CustomerAccountService,
    );

    const result = await service.create(
      session,
      {
        customerId: "customer",
        items: [
          { productId: "product", quantity: 1, unitPriceCents: 1000, discountRate: 0, taxRate: 0 },
        ],
      },
      "idempotency-key",
    );

    expect(result.document.status).toBe("PENDING");
    expect(result.document.pendingCents).toBe(1000);
    expect(tx.document.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "PENDING", totalCents: 1000 }),
    });
  });

  it.each(["PENDING", "PARTIAL", "COMPLETED", "CANCELLED"] as const)(
    "accepts %s as a status filter",
    (status) => {
      expect(documentQuerySchema.safeParse({ page: 1, pageSize: 20, status }).success).toBe(true);
    },
  );
});

describe("DocumentsService.get pending amount", () => {
  it.each([
    { status: "PENDING", paidCents: 0, expectedPendingCents: 1000 },
    { status: "PARTIAL", paidCents: 600, expectedPendingCents: 400 },
    { status: "COMPLETED", paidCents: 1000, expectedPendingCents: 0 },
    { status: "CANCELLED", paidCents: 0, expectedPendingCents: 0 },
  ] as const)("returns $expectedPendingCents cents for $status documents", async (scenario) => {
    const row: Prisma.DocumentGetPayload<{ select: typeof documentDetailSelect }> = {
      ...cancelled,
      status: scenario.status,
      cancellationReason: scenario.status === "CANCELLED" ? "Devolución" : null,
      totalCents: 1000,
    };
    const findUnique = vi.fn().mockResolvedValue(row);
    const aggregate = vi.fn().mockResolvedValue({ _sum: { amount: scenario.paidCents } });
    const service = new DocumentsService(
      {
        document: { findUnique },
        accountEntry: { aggregate },
      } as unknown as DatabaseService,
      {} as CustomerAccountService,
    );

    const result = await service.get(session, "doc");

    expect(result.pendingCents).toBe(scenario.expectedPendingCents);
    if (scenario.status === "PENDING" || scenario.status === "PARTIAL") {
      expect(aggregate).toHaveBeenCalledWith({
        where: {
          companyId: "company",
          documentId: "doc",
          type: { in: ["PAYMENT_APPLIED", "CREDIT_APPLIED"] },
        },
        _sum: { amount: true },
      });
    } else {
      expect(aggregate).not.toHaveBeenCalled();
    }
  });
});
