import "dotenv/config";
import "./setup-env.js";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { DatabaseService } from "../src/database/database.service.js";
import { CASH_ALERT_RECIPIENTS } from "../src/cash/cash-alert-recipients.js";
import { MAIL_TRANSPORT, type MailTransport } from "../src/notifications/mail-transport.js";
import { createTestCustomer } from "./helpers/customers.js";
import { adminRoleId } from "./roles.helpers.js";

export type CashFixture = { companyId: string; userId: string; cookie: string; name: string };
export type CashTestResponse = {
  body: unknown;
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
};
interface CashTestRequest extends PromiseLike<CashTestResponse> {
  set(field: string, value: string): CashTestRequest;
  send(data: object): CashTestRequest;
  expect(status: number): Promise<CashTestResponse>;
}
export function cashHttp(
  app: INestApplication,
  method: "get" | "post",
  path: string,
): CashTestRequest {
  const agent = request(app.getHttpServer());
  return (method === "get" ? agent.get(path) : agent.post(path)) as unknown as CashTestRequest;
}

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

// Shared fixtures for the three cash-operation suites; never touch demo tenants.
export class CashTestHarness {
  app!: INestApplication;
  database!: DatabaseService;
  resetRateLimits!: () => void;
  private readonly companies = new Set<string>();
  private readonly users = new Set<string>();
  private sequence = 0;

  async init(recipients?: readonly string[]): Promise<void> {
    const transport: MailTransport = {
      send: () => Promise.reject(new Error("E2E must not send SMTP mail")),
    };
    const builder = NestTest.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(transport);
    if (recipients !== undefined)
      builder.overrideProvider(CASH_ALERT_RECIPIENTS).useValue(recipients);
    const moduleRef = await builder.compile();
    this.app = moduleRef.createNestApplication({ bodyParser: false });
    this.resetRateLimits = configureHttpSecurity(this.app);
    this.database = this.app.get(DatabaseService);
    await this.app.init();
  }

  async fixture(companyId?: string, name = "Ana E2E"): Promise<CashFixture> {
    const id = companyId ?? `e2e-cash-operations-${randomUUID()}`;
    if (!companyId) {
      this.companies.add(id);
      await this.database.company.create({ data: { id, name: id, legalName: id } });
    }
    const email = `e2e-cash-${randomUUID()}@e2e.operia.invalid`;
    const password = "e2e-cash-password";
    const roleId = await adminRoleId(this.database, id);
    const user = await this.database.user.create({
      data: {
        email,
        name,
        passwordHash: await argon2.hash(password),
        memberships: { create: { companyId: id, roleId } },
      },
    });
    this.users.add(user.id);
    const login = await cashHttp(this.app, "post", "/auth/login")
      .send({ email, password })
      .expect(200);
    const header = login.headers["set-cookie"];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== "string") throw new Error("El login no creó la cookie.");
    return { companyId: id, userId: user.id, name, cookie: value.split(";")[0]! };
  }

  async customer(fixture: CashFixture, status: "ACTIVE" | "INACTIVE" = "ACTIVE"): Promise<string> {
    const base = String(++this.sequence).padStart(10, "0");
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const rest =
      11 - (weights.reduce((sum, weight, index) => sum + Number(base[index]) * weight, 0) % 11);
    const cuit = `${base}${rest === 11 ? 0 : rest === 10 ? 9 : rest}`;
    return (
      await createTestCustomer(this.database, {
        data: {
          companyId: fixture.companyId,
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
          status,
          vatCondition: "FINAL_CONSUMER",
        },
      })
    ).id;
  }

  async document(
    fixture: CashFixture,
    customerId: string,
    totalCents: number,
    options: {
      status?: "PENDING" | "PARTIAL" | "COMPLETED" | "CANCELLED";
      createdAt?: Date;
    } = {},
  ): Promise<string> {
    const key = randomUUID();
    return (
      await this.database.document.create({
        data: {
          companyId: fixture.companyId,
          customerId,
          customerName: "E2E",
          internalNumber: `0001-${String(++this.sequence).padStart(8, "0")}`,
          pointOfSale: "0001",
          status: options.status ?? "PENDING",
          cancelledAt: options.status === "CANCELLED" ? new Date() : null,
          totalCents,
          idempotencyKey: key,
          requestFingerprint: key,
          searchText: "E2E",
          createdAt: options.createdAt ?? new Date("2026-10-09T12:00:00Z"),
        },
      })
    ).id;
  }

  async session(fixture: CashFixture, openingBalance = 0): Promise<string> {
    return (
      await this.database.cashSession.create({
        data: {
          companyId: fixture.companyId,
          openedByUserId: fixture.userId,
          openingBalance,
        },
      })
    ).id;
  }

  async movement(
    fixture: CashFixture,
    sessionId: string,
    customerId: string,
    amount: number,
    paymentMethod: "CASH" | "TRANSFER" | "CARD" = "CASH",
  ): Promise<string> {
    return (
      await this.database.cashMovement.create({
        data: {
          companyId: fixture.companyId,
          sessionId,
          customerId,
          customerName: "E2E",
          type: "COBRO",
          amount,
          paymentMethod,
          receiptNumber: `fixture-${++this.sequence}`,
        },
      })
    ).id;
  }

  async clean(): Promise<void> {
    const companyId = { in: [...this.companies] };
    const userId = { in: [...this.users] };
    await this.database.mailOutbox.deleteMany({ where: { companyId } });
    await this.database.accountEntry.deleteMany({ where: { companyId } });
    await this.database.cashMovement.deleteMany({ where: { companyId } });
    await this.database.cashSession.deleteMany({ where: { companyId } });
    await this.database.documentItem.deleteMany({ where: { companyId } });
    await this.database.stockMovement.deleteMany({ where: { companyId, type: "REVERSION" } });
    await this.database.stockMovement.deleteMany({ where: { companyId } });
    await this.database.document.deleteMany({ where: { companyId } });
    await this.database.product.deleteMany({ where: { companyId } });
    await this.database.elemSubType.deleteMany({ where: { companyId } });
    await this.database.customer.deleteMany({ where: { companyId } });
    await this.database.receiptCounter.deleteMany({ where: { companyId } });
    await this.database.documentCounter.deleteMany({ where: { companyId } });
    await this.database.session.deleteMany({ where: { userId } });
    await this.database.membership.deleteMany({ where: { userId } });
    await this.database.user.deleteMany({ where: { id: userId } });
    await this.database.company.deleteMany({ where: { id: companyId } });
    this.companies.clear();
    this.users.clear();
  }
}
