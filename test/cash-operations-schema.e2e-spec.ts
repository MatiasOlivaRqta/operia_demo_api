import "dotenv/config";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseService } from "../src/database/database.service.js";
import { createTestCustomer } from "./helpers/customers.js";
import type { Prisma } from "../src/generated/prisma/client.js";

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
const userEmail = process.env.DEMO_USER_EMAIL;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
if (!userEmail) throw new Error("Las pruebas E2E requieren DEMO_USER_EMAIL.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("Cash operations schema constraints (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let companyId: string;
  let otherCompanyId: string;
  let customerId: string;
  let documentId: string;
  let movementId: string;
  let sessionId: string;
  let userId: string;
  const companyIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    database = app.get(DatabaseService);
    await app.init();
    userId = (await database.user.findUniqueOrThrow({ where: { email: userEmail } })).id;
    companyId = await createCompany();
    otherCompanyId = await createCompany();
    customerId = await createCustomer(companyId);
    sessionId = (await database.cashSession.create({ data: sessionData(companyId) })).id;
    documentId = (
      await database.document.create({
        data: {
          companyId,
          customerId,
          customerName: "E2E",
          internalNumber: "E2E-1",
          status: "PENDING",
          totalCents: 100,
          idempotencyKey: "document-key",
          requestFingerprint: "fixture",
          searchText: "E2E",
        },
      })
    ).id;
    movementId = (
      await database.cashMovement.create({
        data: movementData(companyId, sessionId, customerId, "R-1"),
      })
    ).id;
  });

  afterAll(async () => {
    for (const id of companyIds) await database.company.deleteMany({ where: { id } });
    await app?.close();
  });

  it.each([0, -1])("rejects account entry amount %i", async (amount) => {
    await expect(
      database.accountEntry.create({
        data: {
          companyId,
          customerId,
          type: "PAYMENT_APPLIED",
          amount,
          documentId,
          cashMovementId: movementId,
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts coherent references for each entry type", async () => {
    await database.accountEntry.create({
      data: {
        companyId,
        customerId,
        type: "PAYMENT_APPLIED",
        amount: 1,
        documentId,
        cashMovementId: movementId,
      },
    });
    await database.accountEntry.create({
      data: {
        companyId,
        customerId,
        type: "CREDIT_GENERATED",
        amount: 1,
        cashMovementId: movementId,
      },
    });
    await database.accountEntry.create({
      data: { companyId, customerId, type: "CREDIT_APPLIED", amount: 1, documentId },
    });
  });

  it("rejects every incoherent reference combination per type", async () => {
    const types = ["PAYMENT_APPLIED", "CREDIT_GENERATED", "CREDIT_APPLIED"] as const;
    for (const type of types) {
      for (const hasDocument of [false, true]) {
        for (const hasMovement of [false, true]) {
          const valid =
            type === "PAYMENT_APPLIED"
              ? hasDocument && hasMovement
              : type === "CREDIT_GENERATED"
                ? !hasDocument && hasMovement
                : hasDocument && !hasMovement;
          if (valid) continue;
          await expect(
            database.accountEntry.create({
              data: {
                companyId,
                customerId,
                type,
                amount: 1,
                documentId: hasDocument ? documentId : null,
                cashMovementId: hasMovement ? movementId : null,
              },
            }),
          ).rejects.toThrow();
        }
      }
    }
  });

  it("rejects CLOSED sessions missing any required closing field", async () => {
    const complete = {
      status: "CLOSED",
      closedAt: new Date(),
      closedByUserId: userId,
      declaredBalance: 0n,
      theoreticalBalance: 0n,
      difference: 0n,
    } as const;
    const fields = [
      "closedAt",
      "closedByUserId",
      "declaredBalance",
      "theoreticalBalance",
      "difference",
    ] as const;
    await expect(
      database.cashSession.create({ data: { ...sessionData(companyId), status: "CLOSED" } }),
    ).rejects.toThrow();
    for (const field of fields) {
      await expect(
        database.cashSession.create({
          data: {
            ...sessionData(companyId),
            ...complete,
            [field]: null,
          },
        }),
      ).rejects.toThrow();
    }
    await database.cashSession.create({ data: { ...sessionData(companyId), ...complete } });
  });

  it("rejects OPEN sessions with any closing field", async () => {
    const fields: Prisma.CashSessionUncheckedUpdateInput[] = [
      { closedAt: new Date() },
      { closedByUserId: userId },
      { declaredBalance: 0n },
      { theoreticalBalance: 0n },
      { difference: 0n },
    ];
    for (const data of fields) {
      await expect(
        database.cashSession.update({
          where: { id_companyId: { id: sessionId, companyId } },
          data,
        }),
      ).rejects.toThrow();
    }
  });

  it("enforces notification key uniqueness across companies", async () => {
    const data = {
      companyId,
      type: "CASH_CLOSE_DIFFERENCE",
      notificationKey: `cash-close:${sessionId}`,
      recipients: ["alerts@e2e.operia.invalid"],
      payload: {},
    } as const;
    await database.mailOutbox.create({ data: { ...data, recipients: [...data.recipients] } });
    for (const id of [companyId, otherCompanyId]) {
      await expect(
        database.mailOutbox.create({
          data: { ...data, companyId: id, recipients: [...data.recipients] },
        }),
      ).rejects.toThrow();
    }
  });

  it("scopes idempotency keys to the company and permits null keys", async () => {
    await database.cashMovement.create({
      data: {
        ...movementData(companyId, sessionId, customerId, "R-2"),
        idempotencyKey: "collection-key",
      },
    });
    await expect(
      database.cashMovement.create({
        data: {
          ...movementData(companyId, sessionId, customerId, "R-3"),
          idempotencyKey: "collection-key",
        },
      }),
    ).rejects.toThrow();
    const otherCustomer = await createCustomer(otherCompanyId);
    const otherSession = await database.cashSession.create({ data: sessionData(otherCompanyId) });
    await database.cashMovement.create({
      data: {
        ...movementData(otherCompanyId, otherSession.id, otherCustomer, "R-2"),
        idempotencyKey: "collection-key",
      },
    });
    await database.cashMovement.create({
      data: movementData(companyId, sessionId, customerId, "R-4"),
    });
  });

  function sessionData(id: string): Prisma.CashSessionUncheckedCreateInput {
    return { companyId: id, openedByUserId: userId, openingBalance: 0 };
  }

  function movementData(
    id: string,
    session: string,
    customer: string,
    receiptNumber: string,
  ): Prisma.CashMovementUncheckedCreateInput {
    return {
      companyId: id,
      sessionId: session,
      customerId: customer,
      customerName: "E2E",
      type: "COBRO",
      paymentMethod: "CASH",
      receiptNumber,
      amount: 100,
    };
  }

  async function createCompany(): Promise<string> {
    const id = `e2e-cash-operations-${crypto.randomUUID()}`;
    companyIds.push(id);
    await database.company.create({ data: { id, name: id, legalName: id } });
    return id;
  }

  async function createCustomer(id: string): Promise<string> {
    const digits = `${Date.now()}`.slice(-8).padStart(8, "0");
    const base = `30${digits}`;
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const rest =
      11 - (weights.reduce((sum, weight, index) => sum + Number(base[index]) * weight, 0) % 11);
    const cuit = `${base}${rest === 11 ? 0 : rest === 10 ? 9 : rest}`;
    const customer = await createTestCustomer(database, {
      data: {
        companyId: id,
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
    });
    return customer.id;
  }
});
