import "dotenv/config";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseService } from "../src/database/database.service.js";
import { createTestCustomer } from "./helpers/customers.js";

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
const userEmail = process.env.DEMO_USER_EMAIL;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
if (!userEmail) throw new Error("Las pruebas E2E requieren DEMO_USER_EMAIL.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("Cash schema constraints (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  const companyIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    database = app.get(DatabaseService);
    await app.init();
  });

  afterAll(async () => {
    for (const id of companyIds) await database.company.deleteMany({ where: { id } });
    await app?.close();
  });

  it("enforces positive amounts, receipt uniqueness per company, and one open session", async () => {
    const user = await database.user.findUniqueOrThrow({
      where: { email: userEmail },
      select: { id: true },
    });
    const first = await createCompany("schema-a");
    const second = await createCompany("schema-b");
    const customerA = await createCustomer(first.id, "customer-a");
    const customerB = await createCustomer(second.id, "customer-b");
    const sessionA = await createSession(first.id, user.id);
    await createSession(second.id, user.id);

    await expect(
      createMovement(first.id, sessionA.id, customerA.id, "R-0001", 0),
    ).rejects.toThrow();
    await expect(
      createMovement(first.id, sessionA.id, customerA.id, "R-0002", -1),
    ).rejects.toThrow();
    await createMovement(first.id, sessionA.id, customerA.id, "R-0003", 100);
    await expect(
      createMovement(first.id, sessionA.id, customerA.id, "R-0003", 200),
    ).rejects.toThrow();
    await createMovement(second.id, (await findSession(second.id)).id, customerB.id, "R-0003", 100);

    await expect(createSession(first.id, user.id)).rejects.toThrow();
    await database.cashSession.update({
      where: { id_companyId: { id: sessionA.id, companyId: first.id } },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        closedByUserId: user.id,
        declaredBalance: 0n,
        theoreticalBalance: 0n,
        difference: 0n,
      },
    });
    await createSession(first.id, user.id);
  });

  async function createCompany(suffix: string): Promise<{ id: string }> {
    const id = `e2e-cash-${suffix}-${crypto.randomUUID()}`;
    companyIds.push(id);
    return database.company.create({ data: { id, legalName: id, name: id }, select: { id: true } });
  }

  async function createCustomer(companyId: string, suffix: string): Promise<{ id: string }> {
    const digits = `${Date.now()}`.slice(-8).padStart(8, "0");
    const base = `30${digits}`;
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const rest =
      11 - (weights.reduce((sum, weight, index) => sum + Number(base[index]) * weight, 0) % 11);
    const cuit = `${base}${rest === 11 ? 0 : rest === 10 ? 9 : rest}`;
    return createTestCustomer(database, {
      data: {
        companyId,
        documentNumber: cuit,
        legalName: suffix,
        commercialName: suffix,
        contactName: "E2E",
        email: `${suffix}@e2e.operia.invalid`,
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

  async function createSession(companyId: string, userId: string): Promise<{ id: string }> {
    return database.cashSession.create({
      data: { companyId, openedByUserId: userId, openingBalance: 0 },
      select: { id: true },
    });
  }

  async function findSession(companyId: string): Promise<{ id: string }> {
    return database.cashSession.findFirstOrThrow({ where: { companyId }, select: { id: true } });
  }

  async function createMovement(
    companyId: string,
    sessionId: string,
    customerId: string,
    receiptNumber: string,
    amount: number,
  ): Promise<void> {
    await database.cashMovement.create({
      data: {
        companyId,
        sessionId,
        customerId,
        customerName: "E2E",
        type: "COBRO",
        paymentMethod: "CASH",
        receiptNumber,
        amount,
      },
    });
  }
});
