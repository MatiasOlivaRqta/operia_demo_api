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

describe("Cash aggregation precision (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let companyId: string;

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    database = app.get(DatabaseService);
    await app.init();
  });

  afterAll(async () => {
    if (companyId) await database.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  });

  it("sums cash movements exactly above the Int32 limit", async () => {
    const user = await database.user.findUniqueOrThrow({
      where: { email: userEmail },
      select: { id: true },
    });
    companyId = `e2e-cash-aggregation-${crypto.randomUUID()}`;
    await database.company.create({
      data: { id: companyId, legalName: companyId, name: companyId },
    });
    const customer = await createCustomer();
    const session = await database.cashSession.create({
      data: { companyId, openedByUserId: user.id, openingBalance: 0 },
      select: { id: true },
    });
    for (const receiptNumber of ["R-0001", "R-0002", "R-0003"]) {
      await database.cashMovement.create({
        data: {
          companyId,
          sessionId: session.id,
          customerId: customer.id,
          customerName: "E2E",
          receiptNumber,
          type: "COBRO",
          paymentMethod: "CASH",
          amount: 1_000_000_000,
        },
      });
    }

    const grouped = await database.cashMovement.groupBy({
      by: ["paymentMethod"],
      _sum: { amount: true },
      _count: true,
      where: { companyId, sessionId: session.id },
    });
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?._sum.amount).toBe(3_000_000_000);
  });

  async function createCustomer(): Promise<{ id: string }> {
    const digits = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0");
    const base = `30${digits}`;
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const rest =
      11 - (weights.reduce((sum, weight, index) => sum + Number(base[index]) * weight, 0) % 11);
    const cuit = `${base}${rest === 11 ? 0 : rest === 10 ? 9 : rest}`;
    return createTestCustomer(database, {
      data: {
        companyId,
        documentNumber: cuit,
        legalName: "E2E cash aggregation",
        commercialName: "E2E cash aggregation",
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
});
