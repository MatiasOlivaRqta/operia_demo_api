import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CashTestHarness, cashHttp, type CashFixture } from "./cash-operations.helpers.js";
import type { CashReceiptDto } from "../src/cash/cash-collections.mapper.js";
import { CustomerAccountService } from "../src/customer-account/customer-account.service.js";

describe("Cash collections (e2e)", () => {
  const h = new CashTestHarness();
  let own: CashFixture;
  let foreign: CashFixture;
  let customerId: string;
  let sessionId: string;
  let account: CustomerAccountService;
  beforeAll(async () => {
    await h.init();
    account = h.app.get(CustomerAccountService);
  });
  beforeEach(async () => {
    h.resetRateLimits();
    own = await h.fixture();
    foreign = await h.fixture();
    customerId = await h.customer(own);
    sessionId = await h.session(own, 100000);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.clean();
  });
  afterAll(async () => h.app?.close());

  function collect(body: object, key: string | null = randomUUID(), id = sessionId) {
    const call = cashHttp(h.app, "post", `/cash/sessions/${id}/collections`).set(
      "Cookie",
      own.cookie,
    );
    if (key !== null) call.set("Idempotency-Key", key);
    return call.send(body);
  }
  function payload(amountCents: number, documentId?: string) {
    return {
      customerId,
      amountCents,
      paymentMethod: "CASH",
      ...(documentId ? { documentId } : {}),
    };
  }
  async function receipt(amountCents: number, documentId?: string): Promise<CashReceiptDto> {
    return (await collect(payload(amountCents, documentId)).expect(201)).body as CashReceiptDto;
  }
  function balance(id: string) {
    return account.getDocumentBalance(own.companyId, id);
  }
  function totals() {
    return account.getTotals(own.companyId, customerId);
  }
  async function noCollections(): Promise<void> {
    expect(await h.database.cashMovement.count({ where: { companyId: own.companyId } })).toBe(0);
    expect(await h.database.accountEntry.count({ where: { companyId: own.companyId } })).toBe(0);
    expect(
      await h.database.receiptCounter.findUnique({ where: { companyId: own.companyId } }),
    ).toBeNull();
  }

  it("collects an exact document payment with the first numbered receipt and no credit", async () => {
    const doc = await h.document(own, customerId, 184200);
    expect(
      (
        await h.database.document.findUniqueOrThrow({
          where: { id_companyId: { id: doc, companyId: own.companyId } },
        })
      ).status,
    ).toBe("PENDING");
    const result = await receipt(184200, doc);
    expect(result).toMatchObject({
      receiptNumber: "R-0001-00000001",
      customerId,
      amountCents: 184200,
      paymentMethod: "CASH",
      documentId: doc,
      applications: [{ documentId: doc, amountCents: 184200 }],
      creditGeneratedCents: 0,
      customerCreditCents: 0,
    });
    expect(result.occurredAt).toMatch(/-03:00$/);
    expect(await balance(doc)).toMatchObject({ pendingCents: 0, paidCents: 184200 });
    expect(
      (
        await h.database.document.findUniqueOrThrow({
          where: { id_companyId: { id: doc, companyId: own.companyId } },
        })
      ).status,
    ).toBe("COMPLETED");
    expect(await totals()).toEqual({ debtCents: 0, creditCents: 0 });
    expect(
      await h.database.cashMovement.findUniqueOrThrow({
        where: { id_companyId: { id: result.movementId, companyId: own.companyId } },
      }),
    ).toMatchObject({
      sessionId,
      customerId,
      documentId: doc,
      amount: 184200,
      receiptNumber: result.receiptNumber,
    });
    expect(await h.database.accountEntry.findMany({ where: { companyId: own.companyId } })).toEqual(
      [
        expect.objectContaining({
          type: "PAYMENT_APPLIED",
          documentId: doc,
          cashMovementId: result.movementId,
          amount: 184200,
        }),
      ],
    );
  });

  it("reduces document pending with a partial payment", async () => {
    const doc = await h.document(own, customerId, 184200);
    expect(await receipt(100000, doc)).toMatchObject({
      applications: [{ documentId: doc, amountCents: 100000 }],
      creditGeneratedCents: 0,
    });
    expect(await balance(doc)).toMatchObject({ pendingCents: 84200, paidCents: 100000 });
    expect(
      (
        await h.database.document.findUniqueOrThrow({
          where: { id_companyId: { id: doc, companyId: own.companyId } },
        })
      ).status,
    ).toBe("PARTIAL");
    expect(await totals()).toEqual({ debtCents: 84200, creditCents: 0 });
  });

  it("caps a target application and generates credit for its excess", async () => {
    const doc = await h.document(own, customerId, 184200);
    expect(await receipt(200000, doc)).toMatchObject({
      applications: [{ documentId: doc, amountCents: 184200 }],
      creditGeneratedCents: 15800,
      customerCreditCents: 15800,
    });
    expect(await balance(doc)).toMatchObject({ pendingCents: 0 });
    expect(
      (
        await h.database.document.findUniqueOrThrow({
          where: { id_companyId: { id: doc, companyId: own.companyId } },
        })
      ).status,
    ).toBe("COMPLETED");
    expect(await totals()).toEqual({ debtCents: 0, creditCents: 15800 });
  });

  it("allocates account payments in age order independently of insertion order", async () => {
    const newer = await h.document(own, customerId, 150000, {
      createdAt: new Date("2026-10-09T12:00:00Z"),
    });
    const older = await h.document(own, customerId, 100000, {
      createdAt: new Date("2026-10-08T12:00:00Z"),
    });
    const result = await receipt(180000);
    expect(
      result.applications.map(({ documentId, amountCents }) => ({ documentId, amountCents })),
    ).toEqual([
      { documentId: older, amountCents: 100000 },
      { documentId: newer, amountCents: 80000 },
    ]);
    expect(result.creditGeneratedCents).toBe(0);
    expect(await balance(older)).toMatchObject({ pendingCents: 0 });
    expect(await balance(newer)).toMatchObject({ pendingCents: 70000 });
    expect(
      await h.database.document.findMany({
        where: { companyId: own.companyId },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true },
      }),
    ).toEqual([
      { id: older, status: "COMPLETED" },
      { id: newer, status: "PARTIAL" },
    ]);
    expect(await totals()).toEqual({ debtCents: 70000, creditCents: 0 });
  });

  it("credits an overpayment of the whole account", async () => {
    const doc = await h.document(own, customerId, 100000);
    expect(await receipt(130000)).toMatchObject({
      applications: [{ documentId: doc, amountCents: 100000 }],
      creditGeneratedCents: 30000,
      customerCreditCents: 30000,
    });
    expect(await totals()).toEqual({ debtCents: 0, creditCents: 30000 });
  });

  it("credits the entire collection when the customer has no debt", async () => {
    expect(await receipt(50000)).toMatchObject({
      applications: [],
      creditGeneratedCents: 50000,
      customerCreditCents: 50000,
    });
    expect(await totals()).toEqual({ debtCents: 0, creditCents: 50000 });
  });

  it("accepts an inactive customer", async () => {
    await h.database.customer.update({
      where: { id_companyId: { id: customerId, companyId: own.companyId } },
      data: { status: "INACTIVE" },
    });
    expect(await receipt(50000)).toMatchObject({ customerId, creditGeneratedCents: 50000 });
  });

  it("rejects other-customer and cancelled documents without writes", async () => {
    const other = await h.customer(own);
    const wrong = await h.document(own, other, 184200);
    const cancelled = await h.document(own, customerId, 184200, { status: "CANCELLED" });
    for (const doc of [wrong, cancelled]) {
      expect((await collect(payload(184200, doc)).expect(422)).body).toMatchObject({
        error: { code: "business_rule" },
      });
      await noCollections();
    }
  });

  it("rejects an already settled document without consuming the next receipt", async () => {
    const doc = await h.document(own, customerId, 184200);
    await receipt(184200, doc);
    const movements = await h.database.cashMovement.findMany({
      where: { companyId: own.companyId },
    });
    const entries = await h.database.accountEntry.findMany({ where: { companyId: own.companyId } });
    await collect(payload(1, doc)).expect(422);
    expect(await h.database.cashMovement.findMany({ where: { companyId: own.companyId } })).toEqual(
      movements,
    );
    expect(await h.database.accountEntry.findMany({ where: { companyId: own.companyId } })).toEqual(
      entries,
    );
    expect((await receipt(1)).receiptNumber).toBe("R-0001-00000002");
  });

  it("hides foreign documents, customers and sessions with 404 and no writes", async () => {
    const foreignCustomer = await h.customer(foreign);
    const doc = await h.document(foreign, foreignCustomer, 100000);
    const foreignSession = await h.session(foreign);
    const calls = [
      () => collect(payload(1, doc)),
      () => collect({ ...payload(1), customerId: foreignCustomer }),
      () => collect(payload(1), randomUUID(), foreignSession),
    ];
    for (const call of calls) {
      expect((await call().expect(404)).body).toMatchObject({ error: { code: "not_found" } });
      await noCollections();
    }
    expect(await h.database.cashMovement.count({ where: { companyId: foreign.companyId } })).toBe(
      0,
    );
  });

  it("rejects a closed drawer without any collection records", async () => {
    await cashHttp(h.app, "post", `/cash/sessions/${sessionId}/close`)
      .set("Cookie", own.cookie)
      .send({ declaredBalanceCents: 100000 })
      .expect(200);
    expect((await collect(payload(1000)).expect(409)).body).toMatchObject({
      error: { code: "conflict" },
    });
    await noCollections();
  });

  it.each([
    { amountCents: 0 },
    { amountCents: -1 },
    { amountCents: 1.5 },
    { amountCents: 2147483648 },
    { paymentMethod: "CHEQUE" },
    { companyId: "foreign" },
  ])("rejects invalid or unsupported input %j without writes", async (invalid) => {
    expect((await collect({ ...payload(100), ...invalid }).expect(400)).body).toMatchObject({
      error: { code: "validation" },
    });
    await noCollections();
  });

  it("requires Idempotency-Key and authentication", async () => {
    expect((await collect(payload(100), null).expect(400)).body).toMatchObject({
      error: { code: "validation" },
    });
    await cashHttp(h.app, "post", `/cash/sessions/${sessionId}/collections`)
      .set("Idempotency-Key", randomUUID())
      .send(payload(100))
      .expect(401);
    await noCollections();
  });

  it("replays the same receipt once and rejects changed data for the same key", async () => {
    const doc = await h.document(own, customerId, 184200);
    const key = randomUUID();
    const first = (await collect(payload(100000, doc), key).expect(201)).body as CashReceiptDto;
    const replay = await collect(payload(100000, doc), key).expect(200);
    expect(replay.body).toEqual(first);
    expect((await collect(payload(100001, doc), key).expect(409)).body).toMatchObject({
      error: { code: "conflict" },
    });
    expect(
      await h.database.cashMovement.count({
        where: { companyId: own.companyId, idempotencyKey: key },
      }),
    ).toBe(1);
    expect(await h.database.accountEntry.count({ where: { companyId: own.companyId } })).toBe(1);
    expect(await balance(doc)).toMatchObject({ pendingCents: 84200 });
    expect(
      await h.database.receiptCounter.findUniqueOrThrow({ where: { companyId: own.companyId } }),
    ).toMatchObject({ lastNumber: 1 });
  });

  it("numbers receipts consecutively while rejected collections consume no number", async () => {
    await collect(payload(0)).expect(400);
    const cancelled = await h.document(own, customerId, 100, { status: "CANCELLED" });
    await collect(payload(1, cancelled)).expect(422);
    expect((await receipt(100)).receiptNumber).toBe("R-0001-00000001");
    await collect(payload(1, cancelled)).expect(422);
    expect((await receipt(100)).receiptNumber).toBe("R-0001-00000002");
    expect(
      await h.database.receiptCounter.findUniqueOrThrow({ where: { companyId: own.companyId } }),
    ).toMatchObject({ lastNumber: 2 });
  });

  it("gives simultaneous company collections distinct consecutive numbers", async () => {
    const other = await h.customer(own);
    const results = await Promise.all([
      collect(payload(100)),
      collect({ ...payload(200), customerId: other }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results.map((r) => (r.body as CashReceiptDto).receiptNumber).sort()).toEqual([
      "R-0001-00000001",
      "R-0001-00000002",
    ]);
    expect(await h.database.cashMovement.count({ where: { companyId: own.companyId } })).toBe(2);
  });

  it("serializes two admitted payments to the same pending document and credits the second", async () => {
    const doc = await h.document(own, customerId, 184200);
    const lock = account.lockCustomer.bind(account);
    let arrivals = 0;
    let release!: () => void;
    let reject!: (reason: Error) => void;
    const admitted = new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Both real admission reads must finish before either customer lock is taken.
    // This creates genuine overlap, without assuming an HTTP or DB scheduler order.
    const spy = vi
      .spyOn(account, "lockCustomer")
      .mockImplementation(async (tx, company, customer) => {
        if (company === own.companyId && customer === customerId && ++arrivals <= 2) {
          if (arrivals === 1)
            timer = setTimeout(
              () => reject(new Error("Concurrent admissions did not arrive")),
              3000,
            );
          else {
            clearTimeout(timer);
            release();
          }
          await admitted;
        }
        await lock(tx, company, customer);
      });
    try {
      const results = await Promise.all([
        collect(payload(184200, doc)),
        collect(payload(184200, doc)),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      const receipts = results.map((r) => r.body as CashReceiptDto);
      expect(receipts.map((receipt) => receipt.creditGeneratedCents).sort((a, b) => a - b)).toEqual(
        [0, 184200],
      );
      expect(receipts.flatMap((receipt) => receipt.applications)).toEqual([
        expect.objectContaining({ documentId: doc, amountCents: 184200 }),
      ]);
      const finalBalance = await balance(doc);
      expect(finalBalance).not.toBeNull();
      expect(finalBalance).toMatchObject({ pendingCents: 0, paidCents: 184200 });
      expect(finalBalance!.pendingCents).toBeGreaterThanOrEqual(0);
      expect(
        await h.database.document.findUniqueOrThrow({
          where: { id_companyId: { id: doc, companyId: own.companyId } },
          select: { status: true },
        }),
      ).toEqual({ status: "COMPLETED" });
      expect(await totals()).toEqual({ debtCents: 0, creditCents: 184200 });
      const entries = await h.database.accountEntry.findMany({
        where: { companyId: own.companyId },
      });
      expect(entries).toHaveLength(2);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "PAYMENT_APPLIED", amount: 184200 }),
          expect.objectContaining({ type: "CREDIT_GENERATED", amount: 184200 }),
        ]),
      );
    } finally {
      clearTimeout(timer);
      spy.mockRestore();
    }
  });

  it("includes a concurrent cash collection in closing theory or rejects it with 409", async () => {
    const [collection, closing] = await Promise.all([
      collect(payload(50000)),
      cashHttp(h.app, "post", `/cash/sessions/${sessionId}/close`)
        .set("Cookie", own.cookie)
        .send({ declaredBalanceCents: 150000, observation: "Conteo concurrente" }),
    ]);
    expect(closing.status).toBe(200);
    expect([201, 409]).toContain(collection.status);
    const movements = await h.database.cashMovement.findMany({
      where: { companyId: own.companyId, sessionId },
    });
    expect(movements).toHaveLength(collection.status === 201 ? 1 : 0);
    const cash = movements
      .filter((m) => m.paymentMethod === "CASH")
      .reduce((sum, m) => sum + m.amount, 0);
    const session = await h.database.cashSession.findUniqueOrThrow({
      where: { id_companyId: { id: sessionId, companyId: own.companyId } },
    });
    expect(session).toMatchObject({
      status: "CLOSED",
      theoreticalBalance: BigInt(100000 + cash),
      declaredBalance: 150000n,
      difference: BigInt(50000 - cash),
    });
    expect(closing.body).toMatchObject({
      theoreticalBalanceCents: 100000 + cash,
      differenceCents: 50000 - cash,
    });
    expect(await h.database.accountEntry.count({ where: { companyId: own.companyId } })).toBe(
      collection.status === 201 ? 1 : 0,
    );
    expect(
      await h.database.receiptCounter.findUnique({ where: { companyId: own.companyId } }),
    ).toEqual(collection.status === 201 ? expect.objectContaining({ lastNumber: 1 }) : null);
  });

  it("rolls back movement, receipt counter and partially written entries after a deterministic failure", async () => {
    const doc = await h.document(own, customerId, 184200);
    const record = account.recordEntries.bind(account);
    const spy = vi
      .spyOn(account, "recordEntries")
      .mockImplementationOnce(async (tx, company, customer, entries) => {
        // The movement and receipt counter already exist in this transaction. Write
        // one real application, then fail before writing the excess credit.
        await record(tx, company, customer, entries.slice(0, 1));
        throw new Error("E2E deterministic account-entry failure");
      });
    try {
      await collect(payload(200000, doc)).expect(500);
    } finally {
      spy.mockRestore();
    }
    await noCollections();
    expect(await balance(doc)).toMatchObject({ pendingCents: 184200, paidCents: 0 });
    expect(await totals()).toEqual({ debtCents: 184200, creditCents: 0 });
    expect(await receipt(200000, doc)).toMatchObject({
      receiptNumber: "R-0001-00000001",
      creditGeneratedCents: 15800,
    });
  });

  it("reflects receipt data in movement reads and current totals", async () => {
    const doc = await h.document(own, customerId, 184200);
    const before = (
      await cashHttp(h.app, "get", "/cash/sessions/current/totals")
        .set("Cookie", own.cookie)
        .expect(200)
    ).body;
    expect(before).toMatchObject({
      byMethod: { CASH: 0 },
      movementsCount: 0,
      theoreticalCashCents: 100000,
    });
    const result = await receipt(184200, doc);
    const listing = await cashHttp(h.app, "get", `/cash/movements?sessionId=${sessionId}`)
      .set("Cookie", own.cookie)
      .expect(200);
    expect(listing.body).toMatchObject({
      total: 1,
      items: [
        {
          id: result.movementId,
          receiptNumber: result.receiptNumber,
          customerId,
          customerName: result.customerName,
          paymentMethod: result.paymentMethod,
          amountCents: result.amountCents,
          occurredAt: result.occurredAt,
        },
      ],
    });
    expect(
      (
        await cashHttp(h.app, "get", "/cash/sessions/current/totals")
          .set("Cookie", own.cookie)
          .expect(200)
      ).body,
    ).toMatchObject({
      sessionId,
      byMethod: { CASH: 184200, TRANSFER: 0, CARD: 0 },
      movementsCount: 1,
      netCollectedCents: 184200,
      theoreticalCashCents: 284200,
    });
  });
});
