import "dotenv/config";
import * as argon2 from "argon2";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { DatabaseService } from "../src/database/database.service.js";
import { createTestCustomer } from "./helpers/customers.js";
import { adminRoleId } from "./roles.helpers.js";

type TestResponse = {
  body: unknown;
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
};
interface TestRequest {
  set(field: string, value: string): TestRequest;
  send(data: object | string): TestRequest;
  expect(status: number): Promise<TestResponse>;
}
type Movement = {
  id: string;
  occurredAt: string;
  type: string;
  customerId: string;
  customerName: string;
  receiptNumber: string;
  documentNumber: string | null;
  paymentMethod: string;
  amountCents: number;
};
type MovementPage = { items: Movement[]; page: number; pageSize: number; total: number };
type Totals = {
  sessionId: string;
  openedAt: string;
  asOf: string;
  openingBalanceCents: number;
  byMethod: { CASH: number; TRANSFER: number; CARD: number };
  netCollectedCents: number;
  movementsCount: number;
  theoreticalCashCents: number;
};
type Fixture = {
  companyId: string;
  userId: string;
  email: string;
  password: string;
  cookie: string;
};

function httpCall(app: INestApplication, method: "get" | "post", path: string): TestRequest {
  const agent = request(app.getHttpServer());
  return (method === "get" ? agent.get(path) : agent.post(path)) as unknown as TestRequest;
}

function getCookie(response: TestResponse): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") throw new Error("El login no creó la cookie de sesión.");
  return value.split(";")[0]!;
}

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("Cash reads (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let resetRateLimits: () => void;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();
  const userEmails = new Set<string>();
  let sequence = 0;
  let fixtureA: Fixture;
  let fixtureB: Fixture;

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    resetRateLimits = configureHttpSecurity(app);
    database = app.get(DatabaseService);
    await app.init();
  });

  beforeEach(async () => {
    resetRateLimits();
    fixtureA = await createFixture("A");
    fixtureB = await createFixture("B");
  });

  afterEach(async () => cleanTestData());
  afterAll(async () => app?.close());

  it("paginates with totals and keeps equal timestamps in stable id-descending order", async () => {
    const customer = await createCustomer(fixtureA.companyId);
    const cashSession = await createCashSession(fixtureA, customer.id);
    const createdAt = new Date("2026-10-09T15:30:00.000Z");
    const entries = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createMovement(fixtureA, cashSession.id, customer.id, {
          receiptNumber: receipt(),
          createdAt,
          amount: index + 1,
        }),
      ),
    );
    const page1 = await list(fixtureA.cookie, "?page=1&pageSize=2");
    const page2 = await list(fixtureA.cookie, "?page=2&pageSize=2");
    const page3 = await list(fixtureA.cookie, "?page=3&pageSize=2");
    expect(page1).toMatchObject({ page: 1, pageSize: 2, total: 5 });
    expect(page2).toMatchObject({ page: 2, pageSize: 2, total: 5 });
    expect(page3).toMatchObject({ page: 3, pageSize: 2, total: 5 });
    const actual = [...page1.items, ...page2.items, ...page3.items].map(({ id }) => id);
    expect(actual).toEqual(
      entries
        .map(({ id }) => id)
        .sort()
        .reverse(),
    );
    expect(new Set(actual).size).toBe(5);
  });

  it("filters independently by payment method, customer, and session", async () => {
    const customer1 = await createCustomer(fixtureA.companyId);
    const customer2 = await createCustomer(fixtureA.companyId);
    const session1 = await createCashSession(fixtureA, customer1.id);
    const session2 = await createCashSession(fixtureA, customer2.id, { status: "CLOSED" });
    const cash = await createMovement(fixtureA, session1.id, customer1.id, {
      paymentMethod: "CASH",
      receiptNumber: receipt(),
    });
    const card = await createMovement(fixtureA, session1.id, customer2.id, {
      paymentMethod: "CARD",
      receiptNumber: receipt(),
    });
    const transfer = await createMovement(fixtureA, session2.id, customer1.id, {
      paymentMethod: "TRANSFER",
      receiptNumber: receipt(),
    });
    expect((await list(fixtureA.cookie, "?paymentMethod=CARD")).items.map((row) => row.id)).toEqual(
      [card.id],
    );
    expect(
      (await list(fixtureA.cookie, `?customerId=${customer2.id}`)).items.map((row) => row.id),
    ).toEqual([card.id]);
    expect(
      (await list(fixtureA.cookie, `?sessionId=${session2.id}`)).items.map((row) => row.id),
    ).toEqual([transfer.id]);
    expect((await list(fixtureA.cookie, "?paymentMethod=CASH")).items.map((row) => row.id)).toEqual(
      [cash.id],
    );
  });

  it("uses Argentine inclusive day boundaries and validates date range limits", async () => {
    const customer = await createCustomer(fixtureA.companyId);
    const cashSession = await createCashSession(fixtureA, customer.id);
    const boundary = await createMovement(fixtureA, cashSession.id, customer.id, {
      createdAt: new Date("2026-10-10T01:30:00.000Z"),
      receiptNumber: receipt(),
    });
    const inDay = await list(fixtureA.cookie, "?from=2026-10-09&to=2026-10-09");
    expect(inDay.items.map(({ id }) => id)).toContain(boundary.id);
    await httpCall(app, "get", "/cash/movements?from=2026-09-01&to=2026-10-09")
      .set("Cookie", fixtureA.cookie)
      .expect(400);
    await httpCall(app, "get", "/cash/movements?from=2026-09-10&to=2026-10-09")
      .set("Cookie", fixtureA.cookie)
      .expect(200);
    await httpCall(app, "get", "/cash/movements?from=2026-02-31&to=2026-03-01")
      .set("Cookie", fixtureA.cookie)
      .expect(400);
    await httpCall(app, "get", "/cash/movements?from=2026-10-10&to=2026-10-09")
      .set("Cookie", fixtureA.cookie)
      .expect(400);
  });

  it("defaults to the last 30 Argentine calendar days and exempts session scoped history", async () => {
    const customer = await createCustomer(fixtureA.companyId);
    const oldSession = await createCashSession(fixtureA, customer.id, {
      status: "CLOSED",
      openedAt: new Date("2026-08-01T12:00:00.000Z"),
    });
    const recentSession = await createCashSession(fixtureA, customer.id);
    const old = await createMovement(fixtureA, oldSession.id, customer.id, {
      createdAt: new Date("2026-08-30T12:00:00.000Z"),
      receiptNumber: receipt(),
    });
    const recent = await createMovement(fixtureA, recentSession.id, customer.id, {
      createdAt: new Date("2026-10-04T12:00:00.000Z"),
      receiptNumber: receipt(),
    });
    const defaultRows = await list(fixtureA.cookie, "");
    expect(defaultRows.items.map(({ id }) => id)).toContain(recent.id);
    expect(defaultRows.items.map(({ id }) => id)).not.toContain(old.id);
    expect(
      (await list(fixtureA.cookie, `?sessionId=${oldSession.id}`)).items.map(({ id }) => id),
    ).toContain(old.id);
  });

  it("rejects invalid pagination, unknown parameters, invalid methods, and hides foreign sessions", async () => {
    const foreignCustomer = await createCustomer(fixtureB.companyId);
    const foreignSession = await createCashSession(fixtureB, foreignCustomer.id);
    const foreignCookie = getCookie(
      await httpCall(app, "post", "/auth/login")
        .send({ email: fixtureB.email, password: fixtureB.password })
        .expect(200),
    );
    const invalidRequests = [
      "?pageSize=0",
      "?pageSize=101",
      "?orderBy=amount",
      "?paymentMethod=CHEQUE",
      `?sessionId=${foreignSession.id}`,
    ];
    for (const query of invalidRequests) {
      const response = await httpCall(app, "get", `/cash/movements${query}`)
        .set("Cookie", fixtureA.cookie)
        .expect(query.includes("sessionId") ? 404 : 400);
      if (query.includes("sessionId")) {
        const missing = await httpCall(
          app,
          "get",
          `/cash/movements?sessionId=${crypto.randomUUID()}`,
        )
          .set("Cookie", fixtureA.cookie)
          .expect(404);
        expect((response.body as { error: { message: string } }).error.message).toBe(
          (missing.body as { error: { message: string } }).error.message,
        );
      }
    }
    expect(foreignCookie).toBeTruthy();
  });

  it("isolates companies, requires authentication, and returns the explicit snapshot DTO", async () => {
    const customerA = await createCustomer(fixtureA.companyId, "Antes");
    const customerB = await createCustomer(fixtureB.companyId);
    const sessionA = await createCashSession(fixtureA, customerA.id);
    const sessionB = await createCashSession(fixtureB, customerB.id);
    const own = await createMovement(fixtureA, sessionA.id, customerA.id, {
      receiptNumber: receipt(),
      createdAt: new Date("2026-10-09T15:30:00Z"),
      customerName: "Antes",
    });
    const foreign = await createMovement(fixtureB, sessionB.id, customerB.id, {
      receiptNumber: receipt(),
    });
    await database.customer.update({
      where: { id_companyId: { id: customerA.id, companyId: fixtureA.companyId } },
      data: { commercialName: "Después" },
    });
    const page = await list(fixtureA.cookie, "");
    expect(page.total).toBe(1);
    expect(page.items.map(({ id }) => id)).toEqual([own.id]);
    expect(page.items[0]).toMatchObject({
      occurredAt: "2026-10-09T12:30:00.000-03:00",
      type: "COBRO",
      customerName: "Antes",
      documentNumber: null,
      paymentMethod: "CASH",
      amountCents: 1000,
    });
    expect(page.items[0]).not.toHaveProperty("companyId");
    expect(page.items[0]?.type).toBe("COBRO");
    expect(page.items.map(({ id }) => id)).not.toContain(foreign.id);
    await httpCall(app, "get", "/cash/movements").expect(401);
    await httpCall(app, "get", "/cash/sessions/current/totals").expect(401);
  });

  it("calculates current totals across all methods and theoretical cash", async () => {
    const customer = await createCustomer(fixtureA.companyId);
    const cashSession = await createCashSession(fixtureA, customer.id, { openingBalance: 100000 });
    await createMovement(fixtureA, cashSession.id, customer.id, {
      amount: 184200,
      paymentMethod: "CASH",
      receiptNumber: receipt(),
    });
    await createMovement(fixtureA, cashSession.id, customer.id, {
      amount: 300000,
      paymentMethod: "TRANSFER",
      receiptNumber: receipt(),
    });
    await createMovement(fixtureA, cashSession.id, customer.id, {
      amount: 50000,
      paymentMethod: "CARD",
      receiptNumber: receipt(),
    });
    const result = await totals(fixtureA.cookie);
    expect(result).toMatchObject({
      openingBalanceCents: 100000,
      byMethod: { CASH: 184200, TRANSFER: 300000, CARD: 50000 },
      netCollectedCents: 534200,
      movementsCount: 3,
      theoreticalCashCents: 284200,
    });
    expect(result.asOf).toMatch(/-03:00$/);
    expect(result.openedAt).toMatch(/-03:00$/);
  });

  it("returns zero methods for an empty drawer and absent methods for cash only", async () => {
    const customer = await createCustomer(fixtureA.companyId);
    const empty = await createCashSession(fixtureA, customer.id, { openingBalance: 100000 });
    expect(await totals(fixtureA.cookie)).toMatchObject({
      sessionId: empty.id,
      byMethod: { CASH: 0, TRANSFER: 0, CARD: 0 },
      netCollectedCents: 0,
      movementsCount: 0,
      theoreticalCashCents: 100000,
    });
    await closeCashSession(fixtureA, empty.id);
    const cashOnly = await createCashSession(fixtureA, customer.id, { openingBalance: 2000 });
    await createMovement(fixtureA, cashOnly.id, customer.id, {
      amount: 300,
      paymentMethod: "CASH",
      receiptNumber: receipt(),
    });
    expect(await totals(fixtureA.cookie)).toMatchObject({
      byMethod: { CASH: 300, TRANSFER: 0, CARD: 0 },
      theoreticalCashCents: 2300,
    });
  });

  it("excludes closed sessions and rows created after the returned asOf", async () => {
    const customer = await createCustomer(fixtureA.companyId);
    const previous = await createCashSession(fixtureA, customer.id, { openingBalance: 0 });
    await createMovement(fixtureA, previous.id, customer.id, {
      amount: 90000,
      receiptNumber: receipt(),
    });
    await closeCashSession(fixtureA, previous.id);
    const current = await createCashSession(fixtureA, customer.id, { openingBalance: 5 });
    await createMovement(fixtureA, current.id, customer.id, {
      amount: 1000,
      receiptNumber: receipt(),
    });
    const beforeInsert = await totals(fixtureA.cookie);
    await createMovement(fixtureA, current.id, customer.id, {
      amount: 700,
      receiptNumber: receipt(),
      createdAt: new Date(new Date(beforeInsert.asOf).getTime() + 5),
    });
    expect(beforeInsert).toMatchObject({ byMethod: { CASH: 1000 }, movementsCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await totals(fixtureA.cookie)).toMatchObject({
      byMethod: { CASH: 1700 },
      movementsCount: 2,
    });
  });

  it("returns null without an open drawer and preserves sums above 2^31 exactly", async () => {
    const customer = await createCustomer(fixtureA.companyId);
    const closed = await createCashSession(fixtureA, customer.id, { status: "CLOSED" });
    expect(await totals(fixtureA.cookie)).toBeNull();
    expect(closed.id).toBeTruthy();
    const open = await createCashSession(fixtureA, customer.id);
    await createMovement(fixtureA, open.id, customer.id, {
      amount: 1500000000,
      receiptNumber: receipt(),
    });
    await createMovement(fixtureA, open.id, customer.id, {
      amount: 1500000000,
      receiptNumber: receipt(),
    });
    expect((await totals(fixtureA.cookie)).byMethod.CASH).toBe(3000000000);
  });

  it("isolates current totals by company", async () => {
    const customerA = await createCustomer(fixtureA.companyId);
    const customerB = await createCustomer(fixtureB.companyId);
    await createCashSession(fixtureA, customerA.id);
    const sessionB = await createCashSession(fixtureB, customerB.id);
    await createMovement(fixtureB, sessionB.id, customerB.id, {
      amount: 55555,
      receiptNumber: receipt(),
    });
    expect(await totals(fixtureA.cookie)).toMatchObject({
      byMethod: { CASH: 0, TRANSFER: 0, CARD: 0 },
      movementsCount: 0,
      netCollectedCents: 0,
    });
  });

  async function createFixture(label: string): Promise<Fixture> {
    const id = `e2e-cash-${label.toLowerCase()}-${crypto.randomUUID()}`;
    const email = `${id}@e2e.operia.invalid`;
    const password = "e2e-cash-password";
    const company = await database.company.create({
      data: { id, legalName: id, name: id },
      select: { id: true },
    });
    companyIds.add(company.id);
    const roleId = await adminRoleId(database, id);
    const user = await database.user.create({
      data: {
        email,
        name: id,
        passwordHash: await argon2.hash(password),
        memberships: { create: { companyId: id, roleId } },
      },
      select: { id: true },
    });
    userIds.add(user.id);
    userEmails.add(email);
    const login = await httpCall(app, "post", "/auth/login").send({ email, password }).expect(200);
    return { companyId: id, userId: user.id, email, password, cookie: getCookie(login) };
  }

  async function createCustomer(
    companyId: string,
    name = `Cliente ${++sequence}`,
  ): Promise<{ id: string }> {
    const base = `${String(sequence).padStart(8, "0")}${String(sequence % 100).padStart(2, "0")}`;
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const remainder =
      11 - (weights.reduce((sum, weight, index) => sum + Number(base[index]) * weight, 0) % 11);
    const cuit = `${base}${remainder === 11 ? 0 : remainder === 10 ? 9 : remainder}`;
    return createTestCustomer(database, {
      data: {
        companyId,
        documentNumber: cuit,
        legalName: name,
        commercialName: name,
        contactName: "E2E",
        email: `${crypto.randomUUID()}@e2e.operia.invalid`,
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
      select: { id: true },
    });
  }

  async function createCashSession(
    fixture: Fixture,
    _customerId: string,
    options: { status?: "OPEN" | "CLOSED"; openingBalance?: number; openedAt?: Date } = {},
  ): Promise<{ id: string }> {
    return database.cashSession.create({
      data: {
        companyId: fixture.companyId,
        openedByUserId: fixture.userId,
        openingBalance: options.openingBalance ?? 0,
        status: options.status ?? "OPEN",
        ...(options.openedAt ? { openedAt: options.openedAt } : {}),
        ...(options.status === "CLOSED"
          ? {
              closedAt: new Date(),
              closedByUserId: fixture.userId,
              declaredBalance: 0n,
              theoreticalBalance: 0n,
              difference: 0n,
            }
          : {}),
      },
      select: { id: true },
    });
  }

  async function closeCashSession(fixture: Fixture, id: string): Promise<void> {
    await database.cashSession.update({
      where: { id_companyId: { id, companyId: fixture.companyId } },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        closedByUserId: fixture.userId,
        declaredBalance: 0n,
        theoreticalBalance: 0n,
        difference: 0n,
      },
    });
  }

  async function createMovement(
    fixture: Fixture,
    sessionId: string,
    customerId: string,
    options: {
      amount?: number;
      paymentMethod?: "CASH" | "TRANSFER" | "CARD";
      receiptNumber?: string;
      createdAt?: Date;
      customerName?: string;
    } = {},
  ): Promise<{ id: string }> {
    return database.cashMovement.create({
      data: {
        companyId: fixture.companyId,
        sessionId,
        customerId,
        customerName: options.customerName ?? "Snapshot E2E",
        type: "COBRO",
        paymentMethod: options.paymentMethod ?? "CASH",
        receiptNumber: options.receiptNumber ?? receipt(),
        amount: options.amount ?? 1000,
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      },
      select: { id: true },
    });
  }

  async function list(cookie: string, query: string): Promise<MovementPage> {
    const response = await httpCall(app, "get", `/cash/movements${query}`)
      .set("Cookie", cookie)
      .expect(200);
    return response.body as MovementPage;
  }

  async function totals(cookie: string): Promise<Totals> {
    const response = await httpCall(app, "get", "/cash/sessions/current/totals")
      .set("Cookie", cookie)
      .expect(200);
    return response.body as Totals;
  }

  function receipt(): string {
    return `R-${String(++sequence).padStart(12, "0")}`;
  }

  async function cleanTestData(): Promise<void> {
    if (!database) return;
    const companies = [...companyIds];
    if (companies.length > 0) {
      await database.cashMovement.deleteMany({ where: { companyId: { in: companies } } });
      await database.cashSession.deleteMany({ where: { companyId: { in: companies } } });
      await database.session.deleteMany({ where: { userId: { in: [...userIds] } } });
      await database.membership.deleteMany({ where: { userId: { in: [...userIds] } } });
      await database.company.deleteMany({ where: { id: { in: companies } } });
    }
    if (userIds.size > 0) await database.user.deleteMany({ where: { id: { in: [...userIds] } } });
    if (userEmails.size > 0)
      await database.user.deleteMany({ where: { email: { in: [...userEmails] } } });
    companyIds.clear();
    userIds.clear();
    userEmails.clear();
  }
});
