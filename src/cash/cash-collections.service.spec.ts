import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "../generated/prisma/client.js";
import { DatabaseService } from "../database/database.service.js";
import {
  CustomerAccountService,
  type DocumentBalance,
} from "../customer-account/customer-account.service.js";
import {
  CashCollectionsService,
  collectionFingerprint,
  validateCollectionDocument,
} from "./cash-collections.service.js";
import type { CashCollectionInput } from "./cash-collections.schemas.js";
import type { CashReceiptRow } from "./cash-collections.mapper.js";

const session = { companyId: "company", userId: "user", sessionId: "auth", permissions: [] };
const input: CashCollectionInput = {
  customerId: "customer",
  documentId: "doc",
  amountCents: 200000,
  paymentMethod: "CASH",
};
const document: DocumentBalance = {
  id: "doc",
  customerId: "customer",
  status: "PENDING",
  internalNumber: "0001-00000001",
  createdAt: new Date("2026-10-09T12:00:00Z"),
  totalCents: 184200,
  paidCents: 0,
  pendingCents: 184200,
};
const receipt: CashReceiptRow = {
  id: "movement",
  receiptNumber: "R-0001-00000001",
  createdAt: new Date("2026-10-09T15:00:00Z"),
  customerId: "customer",
  customerName: "Current name",
  paymentMethod: "CASH",
  amount: 200000,
  documentId: "doc",
  requestFingerprint: collectionFingerprint("cash", input),
  accountEntries: [
    {
      type: "PAYMENT_APPLIED",
      amount: 184200,
      documentId: "doc",
      document: { internalNumber: "0001-00000001", createdAt: document.createdAt },
    },
    { type: "CREDIT_GENERATED", amount: 15800, documentId: null, document: null },
  ],
};
function fixture() {
  const query = vi
    .fn()
    .mockResolvedValueOnce([{ id: "cash" }])
    .mockResolvedValue([{ last_number: 1 }]);
  const create = vi.fn().mockResolvedValue({ id: "movement" });
  const tx = {
    $queryRaw: query,
    cashSession: { findUniqueOrThrow: vi.fn().mockResolvedValue({ status: "OPEN" }) },
    customer: { findUniqueOrThrow: vi.fn().mockResolvedValue({ commercialName: "Current name" }) },
    cashMovement: {
      findUnique: vi.fn().mockResolvedValue(null),
      create,
      findUniqueOrThrow: vi.fn().mockResolvedValue(receipt),
    },
  };
  const database = {
    cashMovement: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      work(tx as unknown as Prisma.TransactionClient),
    ),
  };
  const account = {
    lockCustomer: vi.fn().mockResolvedValue(undefined),
    getDocumentBalance: vi.fn().mockResolvedValue(document),
    pendingForAmount: vi.fn().mockResolvedValue([document]),
    recordEntries: vi.fn().mockResolvedValue([]),
    updateSettlementStatuses: vi.fn().mockResolvedValue(undefined),
    getTotals: vi.fn().mockResolvedValue({ debtCents: 0, creditCents: 15800 }),
  };
  return {
    query,
    create,
    tx,
    database,
    account,
    service: new CashCollectionsService(
      database as unknown as DatabaseService,
      account as unknown as CustomerAccountService,
    ),
  };
}

describe("collection fingerprint and admission rules", () => {
  it("uses canonical sorted fields and explicit null for absent target", () => {
    const noTarget = {
      customerId: "customer",
      amountCents: 200000,
      paymentMethod: "CASH" as const,
    };
    expect(collectionFingerprint("cash", noTarget)).toBe(
      createHash("sha256")
        .update(
          '{"amountCents":200000,"customerId":"customer","documentId":null,"paymentMethod":"CASH","sessionId":"cash"}',
        )
        .digest("hex"),
    );
    expect(
      collectionFingerprint("cash", {
        paymentMethod: "CASH",
        amountCents: 200000,
        documentId: "doc",
        customerId: "customer",
      }),
    ).toBe(collectionFingerprint("cash", input));
    for (const patch of [
      { amountCents: 1 },
      { customerId: "other" },
      { documentId: "other" },
      { paymentMethod: "CARD" as const },
    ])
      expect(collectionFingerprint("cash", { ...input, ...patch })).not.toBe(
        collectionFingerprint("cash", input),
      );
    expect(collectionFingerprint("other", input)).not.toBe(collectionFingerprint("cash", input));
  });
  it("admits only pending and partial documents", () => {
    expect(() =>
      validateCollectionDocument("customer", { ...document, status: "PARTIAL" }),
    ).not.toThrow();
    for (const status of ["COMPLETED", "CANCELLED"] as const)
      expect(() => validateCollectionDocument("customer", { ...document, status })).toThrow();
  });
  it.each([
    null,
    { ...document, status: "CANCELLED" as const },
    { ...document, status: "COMPLETED" as const },
    { ...document, customerId: "other" },
  ])("never relaxes ownership or cancellation rules", (row) => {
    expect(() => validateCollectionDocument("customer", row)).toThrow();
  });
});

describe("CashCollectionsService.collect", () => {
  it("locks session then customer, allocates, takes the counter last and records immutable entries", async () => {
    const f = fixture();
    const result = await f.service.collect(session, "cash", input, "collection-key");
    const lockSql = f.query.mock.calls[0]![0] as Prisma.Sql;
    expect(lockSql.text).toContain("FOR SHARE");
    expect(lockSql.values).toEqual(["cash", "company"]);
    expect(f.account.lockCustomer).toHaveBeenCalledWith(f.tx, "company", "customer");
    expect(f.query.mock.invocationCallOrder[0]).toBeLessThan(
      f.account.lockCustomer.mock.invocationCallOrder[0]!,
    );
    expect(f.account.getDocumentBalance).toHaveBeenCalledTimes(2);
    expect(f.account.getDocumentBalance.mock.invocationCallOrder[0]).toBeLessThan(
      f.account.lockCustomer.mock.invocationCallOrder[0]!,
    );
    expect(f.account.lockCustomer.mock.invocationCallOrder[0]).toBeLessThan(
      f.account.getDocumentBalance.mock.invocationCallOrder[1]!,
    );
    const counterSql = f.query.mock.calls[1]![0] as Prisma.Sql;
    expect(counterSql.text).toContain("ON CONFLICT (company_id)");
    expect(counterSql.values).toEqual(["company"]);
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "COBRO",
          customerName: "Current name",
          documentNumber: "0001-00000001",
          receiptNumber: "R-0001-00000001",
          idempotencyKey: "collection-key",
          requestFingerprint: receipt.requestFingerprint,
        }),
      }),
    );
    expect(f.account.recordEntries).toHaveBeenCalledWith(f.tx, "company", "customer", [
      {
        type: "PAYMENT_APPLIED",
        documentId: "doc",
        cashMovementId: "movement",
        amountCents: 184200,
      },
      { type: "CREDIT_GENERATED", cashMovementId: "movement", amountCents: 15800 },
    ]);
    expect(f.account.updateSettlementStatuses).toHaveBeenCalledWith(f.tx, "company", "customer", [
      "doc",
    ]);
    expect(f.account.recordEntries.mock.invocationCallOrder[0]).toBeLessThan(
      f.account.updateSettlementStatuses.mock.invocationCallOrder[0]!,
    );
    expect(f.account.getTotals).toHaveBeenCalledWith("company", "customer", f.tx);
    expect(f.database.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 10000 });
    expect(result).toMatchObject({
      replayed: false,
      receipt: { creditGeneratedCents: 15800, customerCreditCents: 15800 },
    });
  });
  it("rejects a target already settled before collection", async () => {
    const f = fixture();
    f.account.getDocumentBalance.mockResolvedValue({
      ...document,
      status: "COMPLETED",
      paidCents: 184200,
      pendingCents: 0,
    });
    await expect(f.service.collect(session, "cash", input, "collection-key")).rejects.toMatchObject(
      {
        code: "business_rule",
        status: 422,
      },
    );
    expect(f.account.recordEntries).not.toHaveBeenCalled();
  });
  it("credits the full amount when the document settles while waiting for the customer lock", async () => {
    const f = fixture();
    f.account.getDocumentBalance.mockResolvedValueOnce(document).mockResolvedValueOnce({
      ...document,
      status: "COMPLETED",
      paidCents: 184200,
      pendingCents: 0,
    });
    f.account.getTotals.mockResolvedValue({ debtCents: 0, creditCents: 200000 });
    f.tx.cashMovement.findUniqueOrThrow.mockResolvedValue({
      ...receipt,
      accountEntries: [
        { type: "CREDIT_GENERATED", amount: 200000, documentId: null, document: null },
      ],
    });

    const result = await f.service.collect(session, "cash", input, "collection-key");

    expect(result.receipt.creditGeneratedCents).toBe(200000);
    expect(f.account.recordEntries).toHaveBeenCalledWith(f.tx, "company", "customer", [
      { type: "CREDIT_GENERATED", cashMovementId: "movement", amountCents: 200000 },
    ]);
    expect(f.account.updateSettlementStatuses).toHaveBeenCalledWith(
      f.tx,
      "company",
      "customer",
      [],
    );
  });
  it("rejects a settled target without consuming the counter", async () => {
    const f = fixture();
    f.account.getDocumentBalance.mockResolvedValue({ ...document, pendingCents: 0 });
    await expect(f.service.collect(session, "cash", input, "collection-key")).rejects.toMatchObject(
      { code: "business_rule" },
    );
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("uses ordered pending docs for account payments and stores no target document", async () => {
    const f = fixture();
    await f.service.collect(session, "cash", { ...input, documentId: undefined }, "collection-key");
    expect(f.account.pendingForAmount).toHaveBeenCalledWith(f.tx, "company", "customer", 200000);
    expect(f.account.getDocumentBalance).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ documentId: null, documentNumber: null }),
      }),
    );
  });
  it("recalculates every FIFO document touched in one status refresh call", async () => {
    const f = fixture();
    const second = { ...document, id: "doc-2" };
    f.account.pendingForAmount.mockResolvedValue([document, second]);
    await f.service.collect(
      session,
      "cash",
      { ...input, documentId: undefined, amountCents: 200000 },
      "collection-key",
    );
    expect(f.account.updateSettlementStatuses).toHaveBeenCalledWith(f.tx, "company", "customer", [
      "doc",
      "doc-2",
    ]);
  });
  it("rebuilds a replay without a new transaction and returns current credit", async () => {
    const f = fixture();
    f.database.cashMovement.findUnique.mockResolvedValue(receipt);
    f.account.getTotals.mockResolvedValue({ debtCents: 0, creditCents: 500 });
    expect(await f.service.collect(session, "cash", input, "collection-key")).toMatchObject({
      replayed: true,
      receipt: {
        receiptNumber: receipt.receiptNumber,
        creditGeneratedCents: 15800,
        customerCreditCents: 500,
      },
    });
    expect(f.database.$transaction).not.toHaveBeenCalled();
  });
  it("rejects a reused key with a different fingerprint", async () => {
    const f = fixture();
    f.database.cashMovement.findUnique.mockResolvedValue(receipt);
    await expect(
      f.service.collect(session, "cash", { ...input, amountCents: 1 }, "collection-key"),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.database.$transaction).not.toHaveBeenCalled();
  });
  it("rechecks idempotency after waiting for the customer lock", async () => {
    const f = fixture();
    f.tx.cashMovement.findUnique.mockResolvedValueOnce(null).mockResolvedValue(receipt);
    expect(await f.service.collect(session, "cash", input, "collection-key")).toHaveProperty(
      "replayed",
      true,
    );
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "rereads an idempotency P2002 race (different fingerprint: %s)",
    async (different) => {
      const f = fixture();
      f.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint", {
          code: "P2002",
          clientVersion: "7",
          meta: { target: ["company_id", "idempotency_key"] },
        }),
      );
      f.database.cashMovement.findUnique.mockResolvedValueOnce(null).mockResolvedValue({
        ...receipt,
        requestFingerprint: different ? "other" : receipt.requestFingerprint,
      });
      const result = f.service.collect(session, "cash", input, "collection-key");
      if (different) await expect(result).rejects.toMatchObject({ code: "conflict" });
      else expect(await result).toHaveProperty("replayed", true);
      expect(f.account.recordEntries).not.toHaveBeenCalled();
    },
  );
  it("propagates an entry failure from the transaction without returning a receipt", async () => {
    const f = fixture();
    f.account.recordEntries.mockRejectedValue(new Error("Write failed"));
    await expect(f.service.collect(session, "cash", input, "collection-key")).rejects.toThrow(
      "Write failed",
    );
    expect(f.tx.cashMovement.findUniqueOrThrow).not.toHaveBeenCalled();
  });
  it("returns 404 for an absent session and 409 for a closed one before touching the customer", async () => {
    const missing = fixture();
    missing.query.mockReset().mockResolvedValue([]);
    await expect(
      missing.service.collect(session, "cash", input, "collection-key"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(missing.account.lockCustomer).not.toHaveBeenCalled();
    const closed = fixture();
    closed.tx.cashSession.findUniqueOrThrow.mockResolvedValue({ status: "CLOSED" });
    await expect(
      closed.service.collect(session, "cash", input, "collection-key"),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(closed.account.lockCustomer).not.toHaveBeenCalled();
  });
  it("validates the required idempotency header before accessing the database", async () => {
    const f = fixture();
    await expect(f.service.collect(session, "cash", input, undefined)).rejects.toMatchObject({
      code: "validation",
    });
    expect(f.database.cashMovement.findUnique).not.toHaveBeenCalled();
  });
});
