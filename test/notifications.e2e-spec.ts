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
import { adminRoleId, customRoleId } from "./roles.helpers.js";

type Fixture = { companyId: string; cookie: string };
const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("Notifications (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let resetRateLimits: () => void;
  let fixture: Fixture;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

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
    await database.notification.deleteMany({ where: { companyId: { in: companies } } });
    await database.session.deleteMany({ where: { userId: { in: users } } });
    await database.membership.deleteMany({ where: { userId: { in: users } } });
    await database.user.deleteMany({ where: { id: { in: users } } });
    await database.company.deleteMany({ where: { id: { in: companies } } });
    companyIds.clear();
    userIds.clear();
  });
  afterAll(async () => app?.close());

  it("requires a session", async () => {
    await request(app.getHttpServer()).get("/notifications").expect(401);
  });

  it("hides a notification owned by another company", async () => {
    const foreign = await createFixture();
    const row = await createNotification(foreign.companyId, "foreign");
    await request(app.getHttpServer())
      .post(`/notifications/${row.id}/read`)
      .set("Cookie", fixture.cookie)
      .expect(404);
  });

  it("rejects a page size above the endpoint limit", async () => {
    await request(app.getHttpServer())
      .get("/notifications?pageSize=51")
      .set("Cookie", fixture.cookie)
      .expect(400);
  });

  it("lists, counts, marks one, and marks all within the active company", async () => {
    const first = await createNotification(fixture.companyId, "first");
    await createNotification(fixture.companyId, "second");
    const foreign = await createFixture();
    await createNotification(foreign.companyId, "other-company");

    const page = await request(app.getHttpServer())
      .get("/notifications")
      .set("Cookie", fixture.cookie)
      .expect(200);
    expect(page.body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
    expect(page.body.items).toHaveLength(2);
    expect(page.body.items.map((item: { id: string }) => item.id)).not.toContain(
      (await database.notification.findFirstOrThrow({ where: { title: "other-company" } })).id,
    );
    await request(app.getHttpServer())
      .get("/notifications/unread-count")
      .set("Cookie", fixture.cookie)
      .expect(200)
      .expect({ count: 2 });
    await request(app.getHttpServer())
      .post(`/notifications/${first.id}/read`)
      .set("Cookie", fixture.cookie)
      .expect(200)
      .expect({ ok: true });
    await request(app.getHttpServer())
      .get("/notifications/unread-count")
      .set("Cookie", fixture.cookie)
      .expect(200)
      .expect({ count: 1 });
    await request(app.getHttpServer())
      .post("/notifications/read-all")
      .set("Cookie", fixture.cookie)
      .expect(200)
      .expect({ updated: 1 });
  });

  it("denies every notification endpoint without dashboard.read", async () => {
    const row = await createNotification(fixture.companyId, "protected");
    const cookie = await createRoleCookie(fixture.companyId, []);
    const requests = [
      () => request(app.getHttpServer()).get("/notifications"),
      () => request(app.getHttpServer()).get("/notifications/unread-count"),
      () => request(app.getHttpServer()).post(`/notifications/${row.id}/read`),
      () => request(app.getHttpServer()).post("/notifications/read-all"),
    ];
    for (const send of requests) {
      const response = await send().set("Cookie", cookie).expect(403);
      expect(response.body).toMatchObject({ error: { code: "forbidden" } });
    }
    expect((await database.notification.findUniqueOrThrow({ where: { id: row.id } })).readAt).toBe(
      null,
    );
    await request(app.getHttpServer())
      .get("/notifications")
      .set("Cookie", fixture.cookie)
      .expect(200);
    const dashboardCookie = await createRoleCookie(fixture.companyId, ["dashboard.read"]);
    await request(app.getHttpServer())
      .get("/notifications")
      .set("Cookie", dashboardCookie)
      .expect(200);
  });

  async function createFixture(): Promise<Fixture> {
    const companyId = `e2e-notifications-${randomUUID()}`;
    companyIds.add(companyId);
    await database.company.create({
      data: { id: companyId, legalName: companyId, name: companyId },
    });
    const roleId = await adminRoleId(database, companyId);
    const email = `${randomUUID()}@e2e.operia.invalid`;
    const user = await database.user.create({
      data: {
        email,
        name: "E2E Notifications",
        passwordHash: await argon2.hash("e2e-notifications-password"),
        memberships: { create: { companyId, roleId } },
      },
    });
    userIds.add(user.id);
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password: "e2e-notifications-password" })
      .expect(200);
    const header = login.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0] : header;
    if (!cookie) throw new Error("El login no creó la cookie de sesión.");
    return { companyId, cookie: cookie.split(";")[0]! };
  }

  async function createRoleCookie(companyId: string, permissions: string[]): Promise<string> {
    const roleId = await customRoleId(database, companyId, `E2E ${randomUUID()}`, permissions);
    const email = `${randomUUID()}@e2e.operia.invalid`;
    const password = "e2e-notifications-password";
    const user = await database.user.create({
      data: {
        email,
        name: "E2E role notifications",
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

  async function createNotification(companyId: string, title: string) {
    return database.notification.create({
      data: {
        companyId,
        type: "ORDER_MESSAGE",
        title,
        body: "Mensaje de prueba",
        payload: { chatId: "123", messageId: "456" },
      },
    });
  }
});
