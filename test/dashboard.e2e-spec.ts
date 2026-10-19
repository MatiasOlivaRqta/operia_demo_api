import "dotenv/config";
import "./setup-env.js";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import {
  argentinaDayEndExclusive,
  argentinaDayStart,
  todayInArgentina,
} from "../src/common/argentina-time.js";
import { DatabaseService } from "../src/database/database.service.js";
import {
  dashboardActivityResponseSchema,
  dashboardSummarySchema,
} from "../src/dashboard/dashboard.schemas.js";
import { createDashboardCustomer, createDashboardProduct } from "./helpers/dashboard.js";
import { adminRoleId } from "./roles.helpers.js";

type Fixture = { companyId: string; userId: string; cookie: string };

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("Dashboard (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let resetRateLimits: () => void;
  let fixture: Fixture;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();
  let sequence = 0;

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    resetRateLimits = configureHttpSecurity(app);
    database = app.get(DatabaseService);
    await app.init();
  });
  beforeEach(async () => {
    resetRateLimits();
    fixture = await createFixture();
  });
  afterEach(async () => {
    const companies = [...companyIds];
    const users = [...userIds];
    await database.accountEntry.deleteMany({ where: { companyId: { in: companies } } });
    await database.stockMovement.deleteMany({ where: { companyId: { in: companies } } });
    await database.cashMovement.deleteMany({ where: { companyId: { in: companies } } });
    await database.document.deleteMany({ where: { companyId: { in: companies } } });
    await database.cashSession.deleteMany({ where: { companyId: { in: companies } } });
    await database.product.deleteMany({ where: { companyId: { in: companies } } });
    await database.elemSubType.deleteMany({ where: { companyId: { in: companies } } });
    await database.customer.deleteMany({ where: { companyId: { in: companies } } });
    await database.session.deleteMany({ where: { userId: { in: users } } });
    await database.membership.deleteMany({ where: { userId: { in: users } } });
    await database.user.deleteMany({ where: { id: { in: users } } });
    await database.company.deleteMany({ where: { id: { in: companies } } });
    companyIds.clear();
    userIds.clear();
    sequence = 0;
  });
  afterAll(async () => app?.close());

  it("summarizes Argentina day boundaries, collections across sessions, positive debt, stock, and company isolation", async () => {
    const debt = await createDashboardCustomer(database, fixture.companyId, 1);
    const credit = await createDashboardCustomer(database, fixture.companyId, 2);
    const previousDate = previousArgentinaDate();
    const start = argentinaDayStart(todayInArgentina());
    const end = argentinaDayEndExclusive(todayInArgentina());
    const previousEnd = argentinaDayEndExclusive(previousDate);
    await createDocument(fixture.companyId, debt.id, 100, "PENDING", start);
    await createDocument(fixture.companyId, debt.id, 200, "PARTIAL", atArgentinaTime("23:30"));
    await createDocument(fixture.companyId, debt.id, 900, "PENDING", end);
    await createDocument(
      fixture.companyId,
      debt.id,
      50,
      "PENDING",
      new Date(previousEnd.getTime() - 1),
    );
    await createDocument(fixture.companyId, debt.id, 700, "CANCELLED", start);
    await createDocument(fixture.companyId, credit.id, 1_000, "PENDING", start);
    const firstSession = await createCashSession(fixture, true);
    const secondSession = await createCashSession(fixture);
    await createCollection(fixture, firstSession, debt.id, 25);
    await createCollection(fixture, secondSession, credit.id, 1_500);
    const low = await createDashboardProduct(database, fixture.companyId, {
      index: 1,
      stock: 2,
      minimum: 2,
    });
    await createDashboardProduct(database, fixture.companyId, {
      index: 2,
      status: "INACTIVE",
      stock: 0,
      minimum: 2,
    });

    const foreign = await createFixture();
    const foreignCustomer = await createDashboardCustomer(database, foreign.companyId, 3);
    await createDocument(foreign.companyId, foreignCustomer.id, 99_999, "PENDING", start);

    const result = await summary();
    expect(result.date).toBe(todayInArgentina());
    expect(result.salesToday).toEqual({ totalCents: 1_300, count: 3, previousDayTotalCents: 50 });
    expect(result.collectionsToday).toEqual({ totalCents: 1_525, count: 2 });
    expect(result.receivables).toEqual({ balanceCents: 1_225, customersWithBalance: 1 });
    expect(result.lowStockCount).toBe(1);
    expect(low.companyId).toBe(fixture.companyId);
  });

  it("includes cancelled documents in mixed activity with Argentina timestamps and linked refs", async () => {
    const customer = await createDashboardCustomer(database, fixture.companyId, 4);
    const occurredAt = atArgentinaTime("23:30");
    const document = await createDocument(
      fixture.companyId,
      customer.id,
      500,
      "CANCELLED",
      occurredAt,
      customer.commercialName,
    );
    const cashSession = await createCashSession(fixture);
    const collection = await createCollection(
      fixture,
      cashSession,
      customer.id,
      250,
      customer.commercialName,
      new Date(occurredAt.getTime() + 500),
    );
    const product = await createDashboardProduct(database, fixture.companyId, { index: 3 });
    const movement = await database.stockMovement.create({
      data: {
        companyId: fixture.companyId,
        productId: product.id,
        type: "INGRESO",
        quantity: 7,
        reference: "AJ-7",
        note: "E2E",
        createdAt: new Date(occurredAt.getTime() + 1_000),
      },
    });
    const result = await activity();
    expect(result.items.map((item) => item.kind)).toEqual([
      "stock_movement",
      "collection",
      "document",
    ]);
    expect(result.items[0]).toMatchObject({
      id: movement.id,
      occurredAt: expect.stringMatching(/-03:00$/),
      reference: "AJ-7",
      counterparty: product.name,
      quantity: 7,
      status: "INGRESO",
      refId: product.id,
    });
    expect(result.items[1]).toMatchObject({
      id: collection.id,
      reference: collection.receiptNumber,
      counterparty: customer.commercialName,
      amountCents: 250,
      status: "COLLECTED",
      refId: collection.id,
    });
    expect(result.items[2]).toMatchObject({
      id: document.id,
      reference: document.internalNumber,
      counterparty: customer.commercialName,
      amountCents: 500,
      status: "CANCELLED",
      refId: document.id,
    });
  });

  it("isolates activity and applies the requested limit", async () => {
    const own = await createDashboardCustomer(database, fixture.companyId, 5);
    await createDocument(fixture.companyId, own.id, 10, "PENDING", new Date());
    const foreign = await createFixture();
    const other = await createDashboardCustomer(database, foreign.companyId, 6);
    await createDocument(foreign.companyId, other.id, 99, "PENDING", new Date(Date.now() + 1_000));
    expect((await activity("?limit=1")).items).toHaveLength(1);
    expect((await activity("?limit=1")).items[0]).toMatchObject({ amountCents: 10 });
  });

  it.each([0, 21])("rejects activity limit %i", async (limit) => {
    await request(app.getHttpServer())
      .get(`/dashboard/activity?limit=${limit}`)
      .set("Cookie", fixture.cookie)
      .expect(400);
  });

  it("requires a session for summary and activity", async () => {
    await request(app.getHttpServer()).get("/dashboard/summary").expect(401);
    await request(app.getHttpServer()).get("/dashboard/activity").expect(401);
  });

  it("returns the requested activity limit under a 5,000-row document and movement load", async () => {
    const customer = await createDashboardCustomer(database, fixture.companyId, 7);
    const product = await createDashboardProduct(database, fixture.companyId, { index: 8 });
    const time = new Date();
    const documents = Array.from({ length: 2_500 }, (_, index) => {
      const id = randomUUID();
      return {
        id,
        companyId: fixture.companyId,
        customerId: customer.id,
        customerName: customer.commercialName,
        internalNumber: `0001-${String(index + 1).padStart(8, "0")}`,
        pointOfSale: "0001",
        status: "PENDING" as const,
        totalCents: 100,
        idempotencyKey: id,
        requestFingerprint: id,
        searchText: "E2E dashboard volume",
        createdAt: new Date(time.getTime() + index),
      };
    });
    const movements = Array.from({ length: 2_500 }, (_, index) => ({
      id: randomUUID(),
      companyId: fixture.companyId,
      productId: product.id,
      type: "INGRESO" as const,
      quantity: 1,
      reference: `VOL-${index}`,
      note: "E2E volume",
      createdAt: new Date(time.getTime() + index),
    }));
    await database.document.createMany({ data: documents });
    await database.stockMovement.createMany({ data: movements });

    const startedAt = performance.now();
    const result = await activity("?limit=10");
    const elapsedMs = performance.now() - startedAt;
    console.info(`Dashboard activity 5,000 rows: ${elapsedMs.toFixed(1)} ms`);
    expect(result.items).toHaveLength(10);
    expect(elapsedMs).toBeLessThan(500);

    const summaryStartedAt = performance.now();
    const totals = await summary();
    const summaryMs = performance.now() - summaryStartedAt;
    console.info(`Dashboard summary 5,000 rows: ${summaryMs.toFixed(1)} ms`);
    expect(totals.salesToday.count).toBeGreaterThanOrEqual(0);
    expect(summaryMs).toBeLessThan(500);
  }, 60_000);

  async function createFixture(): Promise<Fixture> {
    const companyId = `e2e-dashboard-${randomUUID()}`;
    companyIds.add(companyId);
    await database.company.create({
      data: { id: companyId, legalName: companyId, name: companyId },
    });
    const roleId = await adminRoleId(database, companyId);
    const email = `${randomUUID()}@e2e.operia.invalid`;
    const password = "e2e-dashboard-password";
    const user = await database.user.create({
      data: {
        email,
        name: "E2E Dashboard",
        passwordHash: await argon2.hash(password),
        memberships: { create: { companyId, roleId } },
      },
    });
    userIds.add(user.id);
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password })
      .expect(200);
    const header = login.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0] : header;
    if (!cookie) throw new Error("El login no creó la cookie de sesión.");
    return { companyId, userId: user.id, cookie: cookie.split(";")[0]! };
  }

  async function createDocument(
    companyId: string,
    customerId: string,
    totalCents: number,
    status: "PENDING" | "PARTIAL" | "COMPLETED" | "CANCELLED",
    createdAt: Date,
    customerName = "Snapshot E2E",
  ) {
    const idempotencyKey = randomUUID();
    return database.document.create({
      data: {
        companyId,
        customerId,
        customerName,
        internalNumber: `0001-${String(++sequence).padStart(8, "0")}`,
        pointOfSale: "0001",
        status,
        cancelledAt: status === "CANCELLED" ? createdAt : null,
        totalCents,
        idempotencyKey,
        requestFingerprint: idempotencyKey,
        searchText: "E2E dashboard",
        createdAt,
      },
    });
  }

  // Una sola caja abierta por empresa: la sesión previa se crea cerrada.
  async function createCashSession(owner: Fixture, closed = false) {
    return database.cashSession.create({
      data: {
        companyId: owner.companyId,
        openedByUserId: owner.userId,
        openingBalance: 0,
        ...(closed
          ? {
              status: "CLOSED" as const,
              closedAt: new Date(),
              closedByUserId: owner.userId,
              declaredBalance: 0n,
              theoreticalBalance: 0n,
              difference: 0n,
            }
          : {}),
      },
    });
  }

  async function createCollection(
    owner: Fixture,
    session: { id: string },
    customerId: string,
    amount: number,
    customerName = "Snapshot E2E",
    createdAt?: Date,
  ) {
    return database.cashMovement.create({
      data: {
        companyId: owner.companyId,
        sessionId: session.id,
        customerId,
        customerName,
        type: "COBRO",
        paymentMethod: "TRANSFER",
        receiptNumber: `R-${++sequence}`,
        amount,
        ...(createdAt ? { createdAt } : {}),
      },
    });
  }

  async function summary() {
    const response = await request(app.getHttpServer())
      .get("/dashboard/summary")
      .set("Cookie", fixture.cookie)
      .expect(200);
    return dashboardSummarySchema.parse(response.body);
  }

  async function activity(query = "") {
    const response = await request(app.getHttpServer())
      .get(`/dashboard/activity${query}`)
      .set("Cookie", fixture.cookie)
      .expect(200);
    return dashboardActivityResponseSchema.parse(response.body);
  }

  function atArgentinaTime(time: string): Date {
    return new Date(`${todayInArgentina()}T${time}:00.000-03:00`);
  }

  function previousArgentinaDate(): string {
    const yesterday = new Date(`${todayInArgentina()}T00:00:00.000Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return yesterday.toISOString().slice(0, 10);
  }
});
