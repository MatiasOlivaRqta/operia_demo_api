import "dotenv/config";
import "./setup-env.js";
import { randomUUID } from "node:crypto";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../src/database/database.service.js";
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from "../src/notifications/mail-transport.js";
import { MailOutboxService } from "../src/notifications/mail-outbox.service.js";
import { MailWorker } from "../src/notifications/mail-worker.js";
import type { CashCloseEmailData } from "../src/notifications/cash-close-email.js";

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");
const { env } = await import("../src/config/env.js");

class FakeTransport implements MailTransport {
  delivered: MailMessage[] = [];
  calls = 0;
  failures = 0;
  async send(message: MailMessage): Promise<void> {
    this.calls++;
    if (this.failures-- > 0) throw new TypeError("SMTP password at private@example.com");
    this.delivered.push(message);
  }
}

describe("Mail outbox (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let outbox: MailOutboxService;
  let worker: MailWorker;
  let companyId: string;
  const transport = new FakeTransport();
  const originalEmails = [...env.CASH_ALERT_EMAILS];
  const originalAttempts = env.MAIL_MAX_ATTEMPTS;
  const data: CashCloseEmailData = {
    companyName: "Empresa E2E",
    differenceCents: -200,
    theoreticalCents: 284200,
    declaredCents: 284000,
    closedBy: { name: "Ana", email: "ana@example.com" },
    openedBy: { name: "Luis", email: "luis@example.com" },
    observation: "\r\nBcc: otro@dominio.com",
    openedAt: "2026-10-09T12:00:00Z",
    closedAt: "2026-10-09T21:00:00Z",
  };

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(transport)
      .compile();
    app = moduleRef.createNestApplication();
    database = app.get(DatabaseService);
    outbox = app.get(MailOutboxService);
    worker = app.get(MailWorker);
    await app.init();
  });
  beforeEach(async () => {
    companyId = `e2e-cash-mail-${randomUUID()}`;
    await database.company.create({
      data: { id: companyId, name: companyId, legalName: companyId },
    });
    env.CASH_ALERT_EMAILS = ["configured@example.com", "second@example.com"];
    env.MAIL_MAX_ATTEMPTS = 2;
    transport.delivered = [];
    transport.calls = 0;
    transport.failures = 0;
  });
  afterEach(async () => {
    await database.mailOutbox.deleteMany({ where: { companyId } });
    await database.company.deleteMany({ where: { id: companyId } });
    env.CASH_ALERT_EMAILS = [...originalEmails];
    env.MAIL_MAX_ATTEMPTS = originalAttempts;
  });
  afterAll(async () => app?.close());

  async function enqueue(): Promise<string> {
    const sessionId = randomUUID();
    await database.$transaction((tx) =>
      outbox.enqueueCashCloseDifference(tx, { companyId, sessionId, data }),
    );
    return (
      await database.mailOutbox.findUniqueOrThrow({
        where: { notificationKey: `cash-close:${sessionId}` },
      })
    ).id;
  }
  async function due(id: string): Promise<void> {
    await database.mailOutbox.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
  }

  it("sends once with frozen configured recipients and data payload", async () => {
    const id = await enqueue();
    const queued = await database.mailOutbox.findUniqueOrThrow({ where: { id } });
    expect(queued.payload).toEqual(data);
    env.CASH_ALERT_EMAILS = ["changed@example.com"];
    await worker.processDue();
    await worker.processDue();
    expect(transport.delivered).toHaveLength(1);
    expect(transport.delivered[0]?.recipients).toEqual([
      "configured@example.com",
      "second@example.com",
    ]);
    expect(await database.mailOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "SENT",
      attempts: 1,
      lockedUntil: null,
      lastError: null,
      sentAt: expect.any(Date),
    });
  });
  it("recovers after a failure and stores no address or credential", async () => {
    const id = await enqueue();
    transport.failures = 1;
    await worker.processDue();
    const failed = await database.mailOutbox.findUniqueOrThrow({ where: { id } });
    expect(failed).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastError: "TypeError",
      lockedUntil: null,
    });
    expect(failed.lastError).not.toContain("@");
    expect(failed.lastError).not.toContain("password");
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    await worker.processDue();
    expect(transport.calls).toBe(1);
    await due(id);
    await worker.processDue();
    expect(transport.delivered).toHaveLength(1);
    expect(await database.mailOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "SENT",
      attempts: 2,
    });
  });
  it("stops after exhausting attempts", async () => {
    const id = await enqueue();
    transport.failures = 10;
    await worker.processDue();
    await due(id);
    await worker.processDue();
    await due(id);
    await worker.processDue();
    expect(transport.calls).toBe(2);
    expect(await database.mailOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "FAILED",
      attempts: 2,
      lastError: "TypeError",
      lockedUntil: null,
    });
  });
  it("two independent processors cannot send the same row", async () => {
    await enqueue();
    const secondWorker = new MailWorker(outbox, transport);
    await Promise.all([worker.processDue(), secondWorker.processDue()]);
    expect(transport.calls).toBe(1);
    expect(transport.delivered).toHaveLength(1);
  });
  it("rolls back enqueue and skips zero difference or absent recipients", async () => {
    await expect(
      database.$transaction(async (tx) => {
        await outbox.enqueueCashCloseDifference(tx, { companyId, sessionId: randomUUID(), data });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await database.$transaction((tx) =>
      outbox.enqueueCashCloseDifference(tx, {
        companyId,
        sessionId: randomUUID(),
        data: { ...data, differenceCents: 0 },
      }),
    );
    env.CASH_ALERT_EMAILS = [];
    await database.$transaction((tx) =>
      outbox.enqueueCashCloseDifference(tx, { companyId, sessionId: randomUUID(), data }),
    );
    expect(await database.mailOutbox.count({ where: { companyId } })).toBe(0);
  });
});
