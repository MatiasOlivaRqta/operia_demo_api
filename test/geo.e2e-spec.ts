import "dotenv/config";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { DatabaseService } from "../src/database/database.service.js";

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
const demoEmail = process.env.DEMO_USER_EMAIL;
const demoPassword = process.env.DEMO_USER_PASSWORD;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test") {
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
}
if (!demoEmail || !demoPassword) {
  throw new Error("Las pruebas E2E requieren las credenciales demo del entorno.");
}
process.env.DATABASE_URL = testDatabaseUrl;

const { AppModule } = await import("../src/app.module.js");

describe("Geo API (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttpSecurity(app);
    database = app.get(DatabaseService);
    await app.init();
  });

  afterAll(async () => {
    await database?.session.deleteMany();
    await app?.close();
  });

  it("requires a session and rejects an invalid province id without calling Georef", async () => {
    await request(app.getHttpServer()).get("/geo/provinces").expect(401);
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: demoEmail, password: demoPassword })
      .expect(200);
    const setCookie = login.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
    expect(cookie).toBeTruthy();

    await request(app.getHttpServer())
      .get("/geo/provinces/abc/localities")
      .set("Cookie", cookie as string)
      .expect(400);
  });
});
