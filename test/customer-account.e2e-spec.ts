import "dotenv/config";
import "./setup-env.js";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { DatabaseService } from "../src/database/database.service.js";
import { CustomerAccountService } from "../src/customer-account/customer-account.service.js";
import { createTestCustomer } from "./helpers/customers.js";
import { CashTestHarness, cashHttp, type CashFixture } from "./cash-operations.helpers.js";
import { ensureProductCategory } from "./helpers/categories.js";
import { adminRoleId } from "./roles.helpers.js";

type TestResponse = {
  body: unknown;
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
};
interface TestRequest {
  set(field: string, value: string): TestRequest;
  send(data: object): TestRequest;
  expect(status: number): Promise<TestResponse>;
}
type Fixture = { companyId: string; userId: string; cookie: string };
type Account = {
  customerId: string;
  debtCents: number;
  creditCents: number;
  netBalanceCents: number;
  pending: {
    items: { id: string; pendingCents: number; paidCents: number; date: string }[];
    page: number;
    pageSize: number;
    total: number;
  };
};
type AccountSummary = {
  customerId: string;
  invoicedCents: number;
  collectedCents: number;
  netBalanceCents: number;
};
type AccountMovement = {
  id: string;
  kind: "DOCUMENT" | "CANCELLATION" | "COLLECTION" | "CREDIT_APPLIED";
  occurredAt: string;
  reference: string;
  documentNumber: string | null;
  documentId: string | null;
  cashMovementId: string | null;
  debitCents: number;
  creditCents: number;
  appliedCents: number | null;
  balanceCents: number;
};
function http(app: INestApplication, method: "get" | "post", path: string): TestRequest {
  const agent = request(app.getHttpServer());
  return (method === "get" ? agent.get(path) : agent.post(path)) as unknown as TestRequest;
}
const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("Customer account (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let accountService: CustomerAccountService;
  let resetRateLimits: () => void;
  let fixture: Fixture;
  let foreign: Fixture;
  let customerId: string;
  let sequence = 0;
  const companies = new Set<string>();
  const users = new Set<string>();

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    resetRateLimits = configureHttpSecurity(app);
    database = app.get(DatabaseService);
    accountService = app.get(CustomerAccountService);
    await app.init();
  });
  beforeEach(async () => {
    resetRateLimits();
    fixture = await createFixture();
    foreign = await createFixture();
    customerId = await customer(fixture.companyId);
  });
  afterEach(async () => {
    const companyIds = [...companies];
    const userIds = [...users];
    await database.accountEntry.deleteMany({ where: { companyId: { in: companyIds } } });
    await database.cashMovement.deleteMany({ where: { companyId: { in: companyIds } } });
    await database.cashSession.deleteMany({ where: { companyId: { in: companyIds } } });
    await database.document.deleteMany({ where: { companyId: { in: companyIds } } });
    await database.customer.deleteMany({ where: { companyId: { in: companyIds } } });
    await database.session.deleteMany({ where: { userId: { in: userIds } } });
    await database.membership.deleteMany({ where: { userId: { in: userIds } } });
    await database.user.deleteMany({ where: { id: { in: userIds } } });
    await database.company.deleteMany({ where: { id: { in: companyIds } } });
    companies.clear();
    users.clear();
  });
  afterAll(async () => app?.close());

  it("derives debt, applied payments, credit and negative net balance", async () => {
    const doc = await document(1000);
    expect(await get()).toMatchObject({ debtCents: 1000, creditCents: 0, netBalanceCents: 1000 });
    const movementId = await credit(2000);
    await database.accountEntry.create({
      data: {
        companyId: fixture.companyId,
        customerId,
        documentId: doc,
        cashMovementId: movementId,
        type: "PAYMENT_APPLIED",
        amount: 200,
      },
    });
    const result = await get();
    expect(result).toMatchObject({ debtCents: 800, creditCents: 2000, netBalanceCents: -1200 });
    expect(result.pending.items[0]).toMatchObject({
      id: doc,
      paidCents: 200,
      pendingCents: 800,
      date: expect.stringMatching(/-03:00$/),
    });
    expect(JSON.stringify(result)).not.toContain("companyId");
  });
  it("returns net credit when no pending documents generate debt", async () => {
    await document(999, customerId, "CANCELLED");
    await credit(20000);
    expect(await get()).toMatchObject({
      debtCents: 0,
      creditCents: 20000,
      netBalanceCents: -20000,
      pending: { items: [], total: 0 },
    });
  });
  it("returns summary totals for pending documents, excludes cancelled, and agrees with account balance", async () => {
    await document(300000);
    await document(50000, customerId, "CANCELLED");
    await credit(120000);
    const summary = await summaryFor(customerId);
    expect(summary).toEqual({
      customerId,
      invoicedCents: 300000,
      collectedCents: 120000,
      netBalanceCents: 180000,
    });
    expect(summary.netBalanceCents).toBe((await get()).netBalanceCents);
    const emptyCustomer = await customer(fixture.companyId);
    expect(await summaryFor(emptyCustomer)).toMatchObject({
      customerId: emptyCustomer,
      invoicedCents: 0,
      collectedCents: 0,
      netBalanceCents: 0,
    });
  });
  it("returns 404 for another company's customer and 401 without a session on summary and movements", async () => {
    const foreignCustomer = await customer(foreign.companyId);
    for (const path of [
      `/customers/${foreignCustomer}/account/summary`,
      `/customers/${foreignCustomer}/account/movements`,
    ]) {
      await http(app, "get", path).set("Cookie", fixture.cookie).expect(404);
      await http(app, "get", path).expect(401);
    }
  });
  it("lists document and collection movements with exact running balances and paginates past a new movement", async () => {
    const documentId = await document(184200);
    const movementId = await credit(200000, documentId);
    await database.accountEntry.deleteMany({
      where: { companyId: fixture.companyId, cashMovementId: movementId },
    });
    await database.accountEntry.createMany({
      data: [
        {
          companyId: fixture.companyId,
          customerId,
          cashMovementId: movementId,
          documentId,
          type: "PAYMENT_APPLIED",
          amount: 184200,
        },
        {
          companyId: fixture.companyId,
          customerId,
          cashMovementId: movementId,
          type: "CREDIT_GENERATED",
          amount: 15800,
        },
      ],
    });
    const first = await movements("?limit=1");
    expect(first.items[0]).toMatchObject({
      kind: "COLLECTION",
      documentId,
      cashMovementId: movementId,
      creditCents: 200000,
      balanceCents: -15800,
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await movements(`?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items[0]).toMatchObject({
      kind: "DOCUMENT",
      documentId,
      cashMovementId: null,
      debitCents: 184200,
      balanceCents: 184200,
    });
    expect(second.nextCursor).toBeNull();
    expect(first.items[0]!.balanceCents).toBe((await summaryFor(customerId)).netBalanceCents);

    const isolatedCustomer = await customer(fixture.companyId);
    const originals = [
      await document(1, isolatedCustomer),
      await document(2, isolatedCustomer),
      await document(3, isolatedCustomer),
    ];
    const seen: AccountMovement[] = [];
    const pageOne = await movements("?limit=1", isolatedCustomer);
    seen.push(...pageOne.items);
    await credit(5, undefined, isolatedCustomer);
    let cursor = pageOne.nextCursor;
    while (cursor) {
      const page = await movements(
        `?limit=1&cursor=${encodeURIComponent(cursor)}`,
        isolatedCustomer,
      );
      seen.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(seen.map(({ id }) => id)).toHaveLength(3);
    expect(new Set(seen.map(({ id }) => id)).size).toBe(3);
    expect(new Set(seen.map(({ id }) => id))).toEqual(new Set(originals.map((id) => `doc:${id}`)));
  });
  it("includes cancellations and informational credit applications without changing the balance", async () => {
    const cancelledId = await document(50000, customerId, "CANCELLED");
    const appliedDocument = await document(10000);
    const appliedDocumentNumber = (
      await database.document.findUniqueOrThrow({
        where: { id_companyId: { id: appliedDocument, companyId: fixture.companyId } },
        select: { internalNumber: true },
      })
    ).internalNumber;
    await database.accountEntry.createMany({
      data: [
        {
          companyId: fixture.companyId,
          customerId,
          documentId: appliedDocument,
          type: "CREDIT_APPLIED",
          amount: 5000,
          createdAt: new Date("2026-10-10T12:00:00Z"),
        },
        {
          companyId: fixture.companyId,
          customerId,
          documentId: appliedDocument,
          type: "CREDIT_APPLIED",
          amount: 5000,
          createdAt: new Date("2026-10-10T12:00:01Z"),
        },
      ],
    });
    const response = await movements();
    expect(response.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `doc:${cancelledId}`, kind: "DOCUMENT", debitCents: 50000 }),
        expect.objectContaining({
          id: `can:${cancelledId}`,
          kind: "CANCELLATION",
          creditCents: 50000,
        }),
        expect.objectContaining({
          kind: "CREDIT_APPLIED",
          appliedCents: 5000,
          debitCents: 0,
          creditCents: 0,
        }),
      ]),
    );
    const appliedMovements = response.items.filter(({ kind }) => kind === "CREDIT_APPLIED");
    expect(appliedMovements).toHaveLength(2);
    expect(
      appliedMovements.every(({ documentNumber }) => documentNumber === appliedDocumentNumber),
    ).toBe(true);
    const appliedBalances = appliedMovements.map(({ balanceCents }) => balanceCents);
    expect(new Set(appliedBalances).size).toBe(1);
  });
  it("rejects malformed cursors and invalid limits", async () => {
    await http(app, "get", `/customers/${customerId}/account/movements?cursor=edited`)
      .set("Cookie", fixture.cookie)
      .expect(400);
    for (const limit of [0, 101])
      await http(app, "get", `/customers/${customerId}/account/movements?limit=${limit}`)
        .set("Cookie", fixture.cookie)
        .expect(400);
  });
  it("pages through 3000 direct cash movements with stable ordering and balances", async () => {
    const session = await database.cashSession.create({
      data: { companyId: fixture.companyId, openedByUserId: fixture.userId, openingBalance: 0 },
    });
    const base = new Date("2026-09-01T00:00:00Z").getTime();
    await database.cashMovement.createMany({
      data: Array.from({ length: 3000 }, (_, index) => ({
        companyId: fixture.companyId,
        sessionId: session.id,
        customerId,
        customerName: "E2E volume",
        type: "COBRO" as const,
        paymentMethod: "TRANSFER" as const,
        receiptNumber: `VOL-${String(index).padStart(6, "0")}`,
        amount: 1,
        createdAt: new Date(base + index),
      })),
    });
    const expected = await database.cashMovement.findMany({
      where: { companyId: fixture.companyId, customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true },
    });
    const all: AccountMovement[] = [];
    let cursor: string | null = null;
    let firstPageMs = 0;
    let lastPageMs = 0;
    do {
      const startedAt = performance.now();
      const page = await movements(
        `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      const duration = performance.now() - startedAt;
      if (all.length === 0) firstPageMs = duration;
      all.push(...page.items);
      cursor = page.nextCursor;
      if (cursor === null) lastPageMs = duration;
    } while (cursor !== null);
    console.log(
      `customer-account 3000 movements: first page ${firstPageMs.toFixed(1)}ms, last page ${lastPageMs.toFixed(1)}ms`,
    );
    expect(all).toHaveLength(3000);
    expect(new Set(all.map(({ id }) => id)).size).toBe(3000);
    expect(all.map(({ id }) => id)).toEqual(expected.map(({ id }) => `col:${id}`));
    expect(all.map(({ balanceCents }) => balanceCents)).toEqual(
      Array.from({ length: 3000 }, (_, index) => -(3000 - index)),
    );
  });
  it("paginates stable oldest-first pending documents with totals across every page", async () => {
    const ids = [];
    for (let index = 0; index < 5; index++) ids.push(await document(100));
    const first = await get("?pageSize=2");
    const second = await get("?page=2&pageSize=2");
    const last = await get("?page=3&pageSize=2");
    const empty = await get("?page=4&pageSize=2");
    for (const page of [first, second, last, empty])
      expect(page).toMatchObject({ debtCents: 500, pending: { total: 5, pageSize: 2 } });
    expect(
      [...first.pending.items, ...second.pending.items, ...last.pending.items].map(({ id }) => id),
    ).toEqual(ids.sort());
    expect(empty.pending.items).toEqual([]);
    const forAmount = await database.$transaction(async (tx) => {
      await accountService.lockCustomer(tx, fixture.companyId, customerId);
      return accountService.pendingForAmount(tx, fixture.companyId, customerId, 250);
    });
    expect(forAmount.map(({ id }) => id)).toEqual(ids.slice(0, 3));
  });
  it("applies credit without an open drawer or new cash movements", async () => {
    const doc = await document(1000);
    await credit(500);
    expect(
      await database.cashSession.count({ where: { companyId: fixture.companyId, status: "OPEN" } }),
    ).toBe(0);
    const before = await database.cashMovement.count({ where: { companyId: fixture.companyId } });
    const response = await apply(doc, 300, 201);
    expect(response.body).toMatchObject({
      application: { customerId, documentId: doc, amountCents: 300 },
      document: { id: doc, pendingCents: 700 },
      creditCents: 200,
    });
    expect(await get()).toMatchObject({ debtCents: 700, creditCents: 200, netBalanceCents: 500 });
    expect(await database.cashMovement.count({ where: { companyId: fixture.companyId } })).toBe(
      before,
    );
    expect(
      await database.accountEntry.findMany({
        where: { companyId: fixture.companyId, type: "CREDIT_APPLIED" },
      }),
    ).toEqual([expect.objectContaining({ amount: 300, cashMovementId: null, documentId: doc })]);
  });
  it("rejects insufficient credit with no partial entries", async () => {
    const doc = await document(1000);
    await credit(100);
    await apply(doc, 200, 422);
    expect(await get()).toMatchObject({ debtCents: 1000, creditCents: 100 });
    expect(
      await database.accountEntry.count({
        where: { companyId: fixture.companyId, type: "CREDIT_APPLIED" },
      }),
    ).toBe(0);
  });
  it("rejects an amount above the document pending even with enough credit", async () => {
    const doc = await document(100);
    await credit(1000);
    await apply(doc, 101, 422);
    expect(await get()).toMatchObject({ debtCents: 100, creditCents: 1000 });
  });
  it("rejects cancelled, other-customer and settled documents", async () => {
    await credit(1000);
    const cancelled = await document(100, customerId, "CANCELLED");
    const otherCustomer = await customer(fixture.companyId);
    const other = await document(100, otherCustomer);
    const settled = await document(100);
    await apply(settled, 100, 201);
    for (const doc of [cancelled, other, settled]) await apply(doc, 1, 422);
    expect(await get()).toMatchObject({ debtCents: 0, creditCents: 900 });
  });
  it("returns not_found for missing or foreign-company customers and documents", async () => {
    const foreignCustomer = await customer(foreign.companyId);
    const foreignDocument = await document(100, foreignCustomer, "PENDING", foreign.companyId);
    await credit(1000);
    for (const doc of [foreignDocument, "missing-document"]) {
      expect((await apply(doc, 1, 404)).body).toMatchObject({ error: { code: "not_found" } });
    }
    for (const id of [foreignCustomer, "missing-customer"]) {
      expect(
        (
          await http(app, "get", `/customers/${id}/account`)
            .set("Cookie", fixture.cookie)
            .expect(404)
        ).body,
      ).toMatchObject({ error: { code: "not_found" } });
      await http(app, "post", `/customers/${id}/account/applications`)
        .set("Cookie", fixture.cookie)
        .send({ documentId: foreignDocument, amountCents: 1 })
        .expect(404);
    }
  });
  it("serializes concurrent applications so they never exceed customer credit", async () => {
    const docA = await document(1000);
    const docB = await document(1000);
    await credit(500);
    const results = await Promise.all([docA, docB].map((doc) => applyResult(doc, 400)));
    expect(results.map(({ status }) => status).sort()).toEqual([201, 422]);
    expect(await get()).toMatchObject({ debtCents: 1600, creditCents: 100 });
    expect(
      await database.accountEntry.count({
        where: { companyId: fixture.companyId, type: "CREDIT_APPLIED" },
      }),
    ).toBe(1);
  });
  it("serializes concurrent applications to the same pending document", async () => {
    const doc = await document(500);
    await credit(1000);
    const results = await Promise.all([applyResult(doc, 400), applyResult(doc, 400)]);
    expect(results.map(({ status }) => status).sort()).toEqual([201, 422]);
    expect(await get()).toMatchObject({ debtCents: 100, creditCents: 600 });
  });
  it("rejects unsupported fields and unauthenticated calls", async () => {
    const doc = await document(100);
    const path = `/customers/${customerId}/account`;
    await http(app, "get", path).expect(401);
    await http(app, "post", `${path}/applications`)
      .send({ documentId: doc, amountCents: 1 })
      .expect(401);
    expect(
      (
        await http(app, "post", `${path}/applications`)
          .set("Cookie", fixture.cookie)
          .send({ documentId: doc, amountCents: 1, companyId: foreign.companyId })
          .expect(400)
      ).body,
    ).toMatchObject({ error: { code: "validation" } });
    await http(app, "get", `${path}?extra=1`).set("Cookie", fixture.cookie).expect(400);
  });

  async function createFixture(): Promise<Fixture> {
    const companyId = `e2e-cash-account-${randomUUID()}`;
    companies.add(companyId);
    await database.company.create({
      data: { id: companyId, name: companyId, legalName: companyId },
    });
    const roleId = await adminRoleId(database, companyId);
    const email = `${companyId}@e2e.operia.invalid`;
    const password = "e2e-cash-account-password";
    const user = await database.user.create({
      data: {
        email,
        name: "E2E",
        passwordHash: await argon2.hash(password),
        memberships: { create: { companyId, roleId } },
      },
    });
    users.add(user.id);
    const login = await http(app, "post", "/auth/login").send({ email, password }).expect(200);
    const header = login.headers["set-cookie"];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== "string") throw new Error("El login no creó la cookie.");
    return { companyId, userId: user.id, cookie: value.split(";")[0]! };
  }
  async function customer(companyId: string): Promise<string> {
    const base = String(++sequence).padStart(10, "0");
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const remainder =
      11 - (weights.reduce((sum, weight, index) => sum + Number(base[index]) * weight, 0) % 11);
    const cuit = `${base}${remainder === 11 ? 0 : remainder === 10 ? 9 : remainder}`;
    return (
      await createTestCustomer(database, {
        data: {
          companyId,
          documentNumber: cuit,
          legalName: "E2E",
          commercialName: "E2E",
          contactName: "E2E",
          email: "customer@e2e.operia.invalid",
          phone: "11111111",
          address: "E2E",
          city: "E2E",
          fiscalAddress: "E2E",
          locality: "E2E",
          postalCode: "1000",
          province: "Buenos Aires",
          priceList: "General",
          status: "ACTIVE",
          vatCondition: "FINAL_CONSUMER",
        },
      })
    ).id;
  }
  async function document(
    totalCents: number,
    owner = customerId,
    status: "PENDING" | "PARTIAL" | "COMPLETED" | "CANCELLED" = "PENDING",
    companyId = fixture.companyId,
  ): Promise<string> {
    const key = randomUUID();
    return (
      await database.document.create({
        data: {
          companyId,
          customerId: owner,
          customerName: "Snapshot E2E",
          internalNumber: `0001-${String(++sequence).padStart(8, "0")}`,
          pointOfSale: "0001",
          status,
          cancelledAt: status === "CANCELLED" ? new Date("2026-10-09T13:00:00Z") : null,
          totalCents,
          idempotencyKey: key,
          requestFingerprint: key,
          searchText: "E2E",
          createdAt: new Date("2026-10-09T12:00:00Z"),
        },
      })
    ).id;
  }
  async function credit(amount: number, documentId?: string, owner = customerId): Promise<string> {
    // A generated credit requires a real cash movement; close its fixture session so applications run without an open drawer.
    const session = await database.cashSession.create({
      data: {
        companyId: fixture.companyId,
        openedByUserId: fixture.userId,
        closedByUserId: fixture.userId,
        openingBalance: 0,
        status: "CLOSED",
        closedAt: new Date(),
        declaredBalance: 0n,
        theoreticalBalance: 0n,
        difference: 0n,
      },
    });
    const movement = await database.cashMovement.create({
      data: {
        companyId: fixture.companyId,
        sessionId: session.id,
        customerId: owner,
        customerName: "E2E",
        type: "COBRO",
        paymentMethod: "TRANSFER",
        receiptNumber: `R-${++sequence}`,
        amount,
        documentId: documentId ?? null,
        documentNumber: documentId
          ? (
              await database.document.findUniqueOrThrow({
                where: { id_companyId: { id: documentId, companyId: fixture.companyId } },
                select: { internalNumber: true },
              })
            ).internalNumber
          : null,
      },
    });
    await database.accountEntry.create({
      data: {
        companyId: fixture.companyId,
        customerId: owner,
        cashMovementId: movement.id,
        type: "CREDIT_GENERATED",
        amount,
      },
    });
    return movement.id;
  }
  async function get(query = ""): Promise<Account> {
    return (
      await http(app, "get", `/customers/${customerId}/account${query}`)
        .set("Cookie", fixture.cookie)
        .expect(200)
    ).body as Account;
  }
  async function summaryFor(id: string): Promise<AccountSummary> {
    return (
      await http(app, "get", `/customers/${id}/account/summary`)
        .set("Cookie", fixture.cookie)
        .expect(200)
    ).body as AccountSummary;
  }
  async function movements(
    query = "",
    owner = customerId,
  ): Promise<{ items: AccountMovement[]; nextCursor: string | null }> {
    return (
      await http(app, "get", `/customers/${owner}/account/movements${query}`)
        .set("Cookie", fixture.cookie)
        .expect(200)
    ).body as { items: AccountMovement[]; nextCursor: string | null };
  }
  function apply(documentId: string, amountCents: number, status: number): Promise<TestResponse> {
    return http(app, "post", `/customers/${customerId}/account/applications`)
      .set("Cookie", fixture.cookie)
      .send({ documentId, amountCents })
      .expect(status);
  }
  async function applyResult(documentId: string, amountCents: number): Promise<TestResponse> {
    const response = await request(app.getHttpServer())
      .post(`/customers/${customerId}/account/applications`)
      .set("Cookie", fixture.cookie)
      .send({ documentId, amountCents });
    return {
      body: response.body as unknown,
      status: response.status,
      headers: response.headers as TestResponse["headers"],
    };
  }
});

describe("Customer account document cancellations (e2e)", () => {
  const h = new CashTestHarness();
  let fixture: CashFixture;
  let customerId: string;
  let sessionId: string;
  beforeAll(async () => h.init());
  beforeEach(async () => {
    h.resetRateLimits();
    fixture = await h.fixture();
    customerId = await h.customer(fixture);
    sessionId = await h.session(fixture);
  });
  afterEach(async () => h.clean());
  afterAll(async () => h.app?.close());

  async function sale() {
    const product = await h.database.product.create({
      data: {
        companyId: fixture.companyId,
        sku: "E2E-CANCELLATION",
        barcode: "",
        name: "E2E",
        categoryId: await ensureProductCategory(h.database, fixture.companyId),
        unit: "unidad",
        costCents: 100,
        priceCents: 61400,
        minimumStock: 0,
        stockOnHand: 10,
        status: "ACTIVE",
        searchText: "e2e",
        nameNormalized: "e2e",
      },
    });
    // Exercise the real document creation and stock-out path before cancellation.
    const created = await cashHttp(h.app, "post", "/documents")
      .set("Cookie", fixture.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({
        customerId,
        items: [
          {
            productId: product.id,
            quantity: 3,
            unitPriceCents: 61400,
            discountRate: 0,
            taxRate: 0,
          },
        ],
      })
      .expect(201);
    const document = created.body as { id: string; totalCents: number };
    expect(document.totalCents).toBe(184200);
    expect((await productRow(product.id)).stockOnHand).toBe(7);
    const outgoing = await h.database.stockMovement.findFirstOrThrow({
      where: { companyId: fixture.companyId, documentId: document.id, type: "SALIDA" },
    });
    return { documentId: document.id, productId: product.id, outgoingId: outgoing.id };
  }
  function productRow(id: string) {
    return h.database.product.findUniqueOrThrow({
      where: { id_companyId: { id, companyId: fixture.companyId } },
    });
  }
  function documentRow(id: string) {
    return h.database.document.findUniqueOrThrow({
      where: { id_companyId: { id, companyId: fixture.companyId } },
    });
  }
  function collect(id: string, amountCents = 184200) {
    return cashHttp(h.app, "post", `/cash/sessions/${sessionId}/collections`)
      .set("Cookie", fixture.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ customerId, documentId: id, amountCents, paymentMethod: "CASH" });
  }
  function cancel(id: string) {
    return cashHttp(h.app, "post", `/documents/${id}/cancellation`)
      .set("Cookie", fixture.cookie)
      .send({ reason: "Anulación E2E" });
  }
  function reversals(id: string) {
    return h.database.stockMovement.findMany({
      where: { companyId: fixture.companyId, documentId: id, type: "REVERSION" },
    });
  }

  it("rejects cancellation after an allocated collection and preserves COMPLETED and stock", async () => {
    const saleData = await sale();
    await collect(saleData.documentId).expect(201);
    const before = await documentRow(saleData.documentId);
    expect((await cancel(saleData.documentId).expect(409)).body).toMatchObject({
      error: { code: "conflict" },
    });
    expect(await documentRow(saleData.documentId)).toEqual(before);
    expect(before.status).toBe("COMPLETED");
    expect((await productRow(saleData.productId)).stockOnHand).toBe(7);
    expect(await reversals(saleData.documentId)).toEqual([]);
    expect(
      await h.database.accountEntry.findMany({
        where: { companyId: fixture.companyId, documentId: saleData.documentId },
      }),
    ).toEqual([expect.objectContaining({ type: "PAYMENT_APPLIED", amount: 184200 })]);
  });

  it("rejects cancellation after a partial collection and preserves PARTIAL and stock", async () => {
    const saleData = await sale();
    await collect(saleData.documentId, 1000).expect(201);
    expect((await documentRow(saleData.documentId)).status).toBe("PARTIAL");
    await cancel(saleData.documentId).expect(409);
    expect((await documentRow(saleData.documentId)).status).toBe("PARTIAL");
    expect((await productRow(saleData.productId)).stockOnHand).toBe(7);
    expect(await reversals(saleData.documentId)).toEqual([]);
  });

  it("cancels an unpaid document with the existing 201 contract and restores stock once", async () => {
    const saleData = await sale();
    expect((await cancel(saleData.documentId).expect(201)).body).toMatchObject({
      status: "CANCELLED",
    });
    expect(await documentRow(saleData.documentId)).toMatchObject({
      status: "CANCELLED",
      cancellationReason: "Anulación E2E",
    });
    expect((await productRow(saleData.productId)).stockOnHand).toBe(10);
    expect(await reversals(saleData.documentId)).toEqual([
      expect.objectContaining({ quantity: 3, reversesMovementId: saleData.outgoingId }),
    ]);
    expect(await h.database.accountEntry.count({ where: { companyId: fixture.companyId } })).toBe(
      0,
    );
    expect(await h.database.cashMovement.count({ where: { companyId: fixture.companyId } })).toBe(
      0,
    );
    await cancel(saleData.documentId).expect(409);
    expect((await productRow(saleData.productId)).stockOnHand).toBe(10);
    expect(await reversals(saleData.documentId)).toHaveLength(1);
  });

  it("serializes cancellation against a collection: exactly one operation can succeed", async () => {
    const saleData = await sale();
    const [cancellation, collection] = await Promise.all([
      cancel(saleData.documentId),
      collect(saleData.documentId),
    ]);
    expect([
      [201, 422],
      [409, 201],
    ]).toContainEqual([cancellation.status, collection.status]);
    const collected = collection.status === 201;
    expect((await documentRow(saleData.documentId)).status).toBe(
      collected ? "COMPLETED" : "CANCELLED",
    );
    expect((await productRow(saleData.productId)).stockOnHand).toBe(collected ? 7 : 10);
    expect(await h.database.cashMovement.count({ where: { companyId: fixture.companyId } })).toBe(
      collected ? 1 : 0,
    );
    const entries = await h.database.accountEntry.findMany({
      where: { companyId: fixture.companyId },
    });
    expect(entries).toEqual(
      collected
        ? [
            expect.objectContaining({
              type: "PAYMENT_APPLIED",
              documentId: saleData.documentId,
              amount: 184200,
            }),
          ]
        : [],
    );
    expect(await reversals(saleData.documentId)).toEqual(
      collected
        ? []
        : [expect.objectContaining({ quantity: 3, reversesMovementId: saleData.outgoingId })],
    );
    const account = await cashHttp(h.app, "get", `/customers/${customerId}/account`)
      .set("Cookie", fixture.cookie)
      .expect(200);
    expect(account.body).toMatchObject({ debtCents: 0, creditCents: 0, pending: { items: [] } });
  });
});
