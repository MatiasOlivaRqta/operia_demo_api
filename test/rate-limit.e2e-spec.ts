import "dotenv/config";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import {
  API_RATE_LIMIT_SERVICE,
  ApiRateLimitService,
  apiRateLimiter,
} from "../src/common/api-rate-limit.js";
import { DatabaseService } from "../src/database/database.service.js";

type TestResponse = {
  body: unknown;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
};

interface TestRequest {
  set(field: string, value: string): TestRequest;
  send(data: object | string): TestRequest;
  expect(status: number): Promise<TestResponse>;
}

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

function expectRateLimit(response: TestResponse): void {
  expect(response.body).toMatchObject({
    error: {
      code: "rate_limited",
      message: "Demasiadas solicitudes. Intentá nuevamente más tarde.",
    },
  });
  expect(Number(response.headers["retry-after"])).toBeGreaterThanOrEqual(1);
}

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
const demoEmail = process.env.DEMO_USER_EMAIL;
const demoPassword = process.env.DEMO_USER_PASSWORD;
const hogarEmail = process.env.HOGAR_USER_EMAIL;
const hogarPassword = process.env.HOGAR_USER_PASSWORD;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
if (!demoEmail || !demoPassword || !hogarEmail || !hogarPassword)
  throw new Error("Las pruebas E2E requieren las credenciales demo del entorno.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("API rate limits (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let resetRateLimits: () => void;
  let rateLimit: ApiRateLimitService;

  beforeAll(async () => {
    const rateLimitProvider = new ApiRateLimitService(apiRateLimiter, {
      apiPerMinute: 20,
      anonymousPerMinute: 10,
    });
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_RATE_LIMIT_SERVICE)
      .useValue(rateLimitProvider)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    resetRateLimits = configureHttpSecurity(app);
    rateLimit = app.get(API_RATE_LIMIT_SERVICE);
    database = app.get(DatabaseService);
    await app.init();
  });

  beforeEach(async () => {
    await database.session.deleteMany();
    resetRateLimits();
    rateLimit.configure({ apiPerMinute: 20, anonymousPerMinute: 10 });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("allows one session to make more than 100 requests below its configured limit", async () => {
    rateLimit.configure({ apiPerMinute: 120, anonymousPerMinute: 10 });
    const cookie = await loginAs(demoEmail, demoPassword);

    for (let index = 0; index < 110; index += 1) {
      await httpCall(app, "get", "/auth/me").set("Cookie", cookie).expect(200);
    }
  });

  it("isolates session buckets and returns the shared 429 body with Retry-After", async () => {
    const first = await loginAs(demoEmail, demoPassword);
    const second = await loginAs(hogarEmail, hogarPassword);

    for (let index = 0; index < 20; index += 1) {
      await httpCall(app, "get", "/auth/me").set("Cookie", first).expect(200);
    }
    const blocked = await httpCall(app, "get", "/auth/me").set("Cookie", first).expect(429);
    expectRateLimit(blocked);
    await httpCall(app, "get", "/auth/me").set("Cookie", second).expect(200);
  });

  it("counts unauthenticated requests by IP without blocking an authenticated session", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    resetRateLimits();

    for (let index = 0; index < 10; index += 1) {
      await httpCall(app, "get", "/auth/me").expect(401);
    }
    const blocked = await httpCall(app, "get", "/auth/me").expect(429);
    expectRateLimit(blocked);
    await httpCall(app, "get", "/auth/me").set("Cookie", cookie).expect(200);
  });

  it("isolates failed login attempts by forwarded client IP", async () => {
    for (let index = 0; index < 5; index += 1) {
      await httpCall(app, "post", "/auth/login")
        .set("X-Forwarded-For", "198.51.100.10")
        .send({ email: demoEmail, password: "invalid-password" })
        .expect(401);
    }
    const blocked = await httpCall(app, "post", "/auth/login")
      .set("X-Forwarded-For", "198.51.100.10")
      .send({ email: demoEmail, password: "invalid-password" })
      .expect(429);
    expectRateLimit(blocked);

    await httpCall(app, "post", "/auth/login")
      .set("X-Forwarded-For", "198.51.100.11")
      .send({ email: demoEmail, password: demoPassword })
      .expect(200);
  });

  it("does not let an anonymous flood from one forwarded IP block another login", async () => {
    for (let index = 0; index < 10; index += 1) {
      await httpCall(app, "get", "/auth/me").set("X-Forwarded-For", "198.51.100.20").expect(401);
    }
    const blocked = await httpCall(app, "get", "/auth/me")
      .set("X-Forwarded-For", "198.51.100.20")
      .expect(429);
    expectRateLimit(blocked);

    await httpCall(app, "post", "/auth/login")
      .set("X-Forwarded-For", "198.51.100.21")
      .send({ email: demoEmail, password: demoPassword })
      .expect(200);
  });

  it("ignores forwarded IPs when trust proxy is set to zero", async () => {
    const expressApp = app.getHttpAdapter().getInstance() as {
      set(name: string, value: number): void;
    };
    expressApp.set("trust proxy", 0);
    try {
      for (let index = 0; index < 10; index += 1) {
        await httpCall(app, "get", "/auth/me").set("X-Forwarded-For", "198.51.100.30").expect(401);
      }
      const blocked = await httpCall(app, "get", "/auth/me")
        .set("X-Forwarded-For", "198.51.100.30")
        .expect(429);
      expectRateLimit(blocked);

      const sameSocket = await httpCall(app, "get", "/auth/me")
        .set("X-Forwarded-For", "198.51.100.31")
        .expect(429);
      expectRateLimit(sameSocket);
    } finally {
      expressApp.set("trust proxy", 1);
    }
  });

  async function loginAs(email: string, password: string): Promise<string> {
    const response = await httpCall(app, "post", "/auth/login")
      .send({ email, password })
      .expect(200);
    return getCookie(response);
  }
});
