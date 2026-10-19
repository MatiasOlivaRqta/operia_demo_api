import "dotenv/config";
import "./setup-env.js";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { adminRoleId, customRoleId } from "./roles.helpers.js";

type Fixture = { companyId: string; userId: string; cookie: string };
const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_BOT_USERNAME = "";
const { DatabaseService } = await import("../src/database/database.service.js");
const { TELEGRAM_SETTINGS } = await import("../src/telegram/telegram.config.js");
const { AppModule } = await import("../src/app.module.js");
const testTelegramSettings = {
  botToken: "e2e-test-token",
  botUsername: "operia_e2e_bot",
  pollSeconds: 1,
};

describe("Telegram linking (e2e)", () => {
  let app: INestApplication;
  let database: InstanceType<typeof DatabaseService>;
  let fixture: Fixture;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TELEGRAM_SETTINGS)
      .useValue(testTelegramSettings)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttpSecurity(app);
    database = app.get(DatabaseService);
    await app.init();
  });

  beforeEach(async () => {
    testTelegramSettings.pollSeconds = 1;
    fixture = await createFixture();
  });

  afterEach(async () => {
    const users = [...userIds];
    const companies = [...companyIds];
    await database.session.deleteMany({ where: { userId: { in: users } } });
    await database.membership.deleteMany({ where: { userId: { in: users } } });
    await database.user.deleteMany({ where: { id: { in: users } } });
    await database.telegramChat.deleteMany({ where: { companyId: { in: companies } } });
    await database.telegramLinkToken.deleteMany({ where: { companyId: { in: companies } } });
    await database.company.deleteMany({ where: { id: { in: companies } } });
    companyIds.clear();
    userIds.clear();
  });

  afterAll(async () => app?.close());

  it("requires a session", async () => {
    await request(app.getHttpServer()).post("/telegram/link-token").expect(401);
  });

  it("returns 503 when the bot is not configured", async () => {
    testTelegramSettings.pollSeconds = 0;
    try {
      await request(app.getHttpServer())
        .post("/telegram/link-token")
        .set("Cookie", fixture.cookie)
        .expect(503);
    } finally {
      testTelegramSettings.pollSeconds = 1;
    }
  });

  it("requires users.manage to request a link token", async () => {
    const noPermissionsCookie = await createRoleCookie(fixture.companyId, []);
    const response = await request(app.getHttpServer())
      .post("/telegram/link-token")
      .set("Cookie", noPermissionsCookie)
      .expect(403);
    expect(response.body).toMatchObject({ error: { code: "forbidden" } });
    const adminLink = await request(app.getHttpServer())
      .post("/telegram/link-token")
      .set("Cookie", fixture.cookie)
      .expect(201);
    expect(adminLink.body.url).toMatch(/^https:\/\/t\.me\/operia_e2e_bot\?start=/);
    const managerCookie = await createRoleCookie(fixture.companyId, ["users.manage"]);
    const managerLink = await request(app.getHttpServer())
      .post("/telegram/link-token")
      .set("Cookie", managerCookie)
      .expect(201);
    expect(managerLink.body.url).toMatch(/^https:\/\/t\.me\/operia_e2e_bot\?start=/);
    expect(
      await database.telegramLinkToken.count({ where: { companyId: fixture.companyId } }),
    ).toBe(2);
  });

  async function createFixture(): Promise<Fixture> {
    const companyId = `e2e-telegram-${randomUUID()}`;
    companyIds.add(companyId);
    await database.company.create({
      data: { id: companyId, legalName: companyId, name: companyId },
    });
    const roleId = await adminRoleId(database, companyId);
    const email = `${randomUUID()}@e2e.operia.invalid`;
    const user = await database.user.create({
      data: {
        email,
        name: "E2E Telegram",
        passwordHash: await argon2.hash("e2e-telegram-password"),
        memberships: { create: { companyId, roleId } },
      },
    });
    userIds.add(user.id);
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password: "e2e-telegram-password" })
      .expect(200);
    const header = login.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0] : header;
    if (!cookie) throw new Error("El login no creó la cookie de sesión.");
    return { companyId, userId: user.id, cookie: cookie.split(";")[0]! };
  }

  async function createRoleCookie(companyId: string, permissions: string[]): Promise<string> {
    const roleId = await customRoleId(database, companyId, `E2E ${randomUUID()}`, permissions);
    const email = `${randomUUID()}@e2e.operia.invalid`;
    const password = "e2e-telegram-password";
    const user = await database.user.create({
      data: {
        email,
        name: "E2E role Telegram",
        passwordHash: await argon2.hash(password),
        memberships: { create: { companyId, roleId } },
      },
    });
    userIds.add(user.id);
    const login = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    const header = login.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0] : header;
    if (!cookie) throw new Error("El login no creÃ³ la cookie de sesiÃ³n.");
    return cookie.split(";")[0]!;
  }
});
