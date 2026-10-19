import "dotenv/config";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { DatabaseService } from "../src/database/database.service.js";
import type { CustomerInput } from "../src/customers/customer.schemas.js";
import { hashSessionToken } from "../src/auth/session-token.js";
import { ALL_PERMISSIONS } from "../src/permissions/permissions.catalog.js";

type TestResponse = {
  body: unknown;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
};

interface TestRequest {
  set(field: string, value: string): TestRequest;
  send(data: object | string): TestRequest;
  expect(status: number): Promise<TestResponse>;
}

type ApiErrorResponse = {
  error: { code: string; message: string; fieldErrors?: Record<string, string[]> };
};

type CustomerResponse = CustomerInput & { companyId: string; id: string };

function httpCall(
  application: INestApplication,
  method: "get" | "post" | "put" | "patch",
  path: string,
): TestRequest {
  const testAgent = request(application.getHttpServer());
  const testRequest =
    method === "get"
      ? testAgent.get(path)
      : method === "post"
        ? testAgent.post(path)
        : method === "put"
          ? testAgent.put(path)
          : testAgent.patch(path);
  return testRequest as unknown as TestRequest;
}

function getCookie(response: TestResponse): string {
  const header = response.headers["set-cookie"];
  const setCookie = Array.isArray(header) ? header[0] : header;
  if (typeof setCookie !== "string") throw new Error("El login no creó la cookie de sesión.");
  return setCookie.split(";")[0];
}

function expectApiError(response: TestResponse, code: string): ApiErrorResponse {
  expect(response.body).toMatchObject({
    error: { code, message: expect.any(String) },
  });
  return response.body as ApiErrorResponse;
}

function customerInput(label: string, documentNumber: string): CustomerInput {
  return {
    address: "Av. Prueba 123",
    city: "Ciudad de Buenos Aires",
    commercialName: `Compañía ${label}`,
    contactEmail: `e2e+${label.toLowerCase().replaceAll(" ", "-")}@e2e.operia.invalid`,
    contactName: "Lucía Pérez",
    contactPhone: "+54 11 4555-0128",
    documentNumber,
    documentType: "CUIT/CUIL",
    fiscalAddress: "Av. Prueba 123",
    legalName: `Compañía ${label} S.R.L.`,
    locality: "Almagro",
    postalCode: "C1205",
    priceList: "Mayorista",
    personType: "Jurídica",
    province: "Ciudad Autónoma de Buenos Aires",
    status: "active",
    vatCondition: "Responsable inscripto",
  };
}

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
const demoEmail = process.env.DEMO_USER_EMAIL;
const demoPassword = process.env.DEMO_USER_PASSWORD;
const hogarEmail = process.env.HOGAR_USER_EMAIL;
const hogarPassword = process.env.HOGAR_USER_PASSWORD;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test") {
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
}
if (!demoEmail || !demoPassword || !hogarEmail || !hogarPassword) {
  throw new Error("Las pruebas E2E requieren las credenciales demo del entorno.");
}
process.env.DATABASE_URL = testDatabaseUrl;

const { env } = await import("../src/config/env.js");
const { AppModule } = await import("../src/app.module.js");

describe("Operia API (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let resetRateLimits: () => void;

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    resetRateLimits = configureHttpSecurity(app);
    database = app.get(DatabaseService);
    await app.init();
  });

  beforeEach(async () => {
    await cleanTestData();
    resetRateLimits();
  });

  afterEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("keeps health public and returns uniform 401 errors without or with an invalid cookie", async () => {
    const health = await httpCall(app, "get", "/health").expect(200);
    expect(health.headers["x-powered-by"]).toBeUndefined();
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["cache-control"]).toBe("no-store");

    const missing = await httpCall(app, "get", "/auth/me").expect(401);
    expectApiError(missing, "unauthenticated");
    const invalid = await httpCall(app, "get", "/customers")
      .set("Cookie", "operia_session=invalid")
      .expect(401);
    expectApiError(invalid, "unauthenticated");
  });

  it("logs in with a protected cookie, lists memberships, and changes the active company", async () => {
    const login = await httpCall(app, "post", "/auth/login")
      .set("Origin", "http://localhost:3000")
      .send({ email: demoEmail, password: demoPassword })
      .expect(200);
    const setCookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Lax");
    const cookie = getCookie(login);
    const payload = login.body as { companies: readonly unknown[]; activeCompany: { id: string } };
    expect(payload.companies).toHaveLength(2);
    expect(payload.activeCompany.id).toBe("operia-central");
    expect(login.body).toMatchObject({ role: { name: "ADMIN" } });
    expect(new Set((login.body as { permissions: string[] }).permissions)).toEqual(
      new Set(ALL_PERMISSIONS),
    );

    const companies = await httpCall(app, "get", "/companies").set("Cookie", cookie).expect(200);
    expect((companies.body as Array<{ id: string }>).map(({ id }) => id)).toEqual([
      "operia-central",
      "operia-hogar",
    ]);

    const switched = await httpCall(app, "put", "/session/company/operia-hogar")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .expect(200);
    expect((switched.body as { activeCompany: { id: string } }).activeCompany.id).toBe(
      "operia-hogar",
    );
    expect(switched.body).toMatchObject({ role: { name: "ADMIN" } });
    expect(new Set((switched.body as { permissions: string[] }).permissions)).toEqual(
      new Set(ALL_PERMISSIONS),
    );
    const current = await httpCall(app, "get", "/auth/me").set("Cookie", cookie).expect(200);
    expect((current.body as { activeCompany: { id: string } }).activeCompany.id).toBe(
      "operia-hogar",
    );
    expect(current.body).toMatchObject({ role: { name: "ADMIN" } });
    expect(new Set((current.body as { permissions: string[] }).permissions)).toEqual(
      new Set(ALL_PERMISSIONS),
    );
  });

  it("rejects oversized JSON login bodies with a localized payload error", async () => {
    const response = await httpCall(app, "post", "/auth/login")
      .send({ email: demoEmail, password: demoPassword, extra: "x".repeat(40_000) })
      .expect(413);

    expectApiError(response, "payload_too_large");
  });

  it("keeps each user's latest ten sessions and leaves another user's sessions intact", async () => {
    const otherUserCookie = await loginAs(hogarEmail, hogarPassword);
    const cookies: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      resetRateLimits();
      const login = await httpCall(app, "post", "/auth/login")
        .set("X-Forwarded-For", `192.0.2.${index + 1}`)
        .send({ email: demoEmail, password: demoPassword })
        .expect(200);
      cookies.push(getCookie(login));
    }

    const oldest = await httpCall(app, "get", "/auth/me").set("Cookie", cookies[0]!).expect(401);
    expectApiError(oldest, "unauthenticated");
    await httpCall(app, "get", "/auth/me").set("Cookie", cookies[10]!).expect(200);
    await httpCall(app, "get", "/auth/me").set("Cookie", otherUserCookie).expect(200);
  });

  it("hides membership details and gives identical login errors for unknown users and bad passwords", async () => {
    const login = await httpCall(app, "post", "/auth/login")
      .send({ email: hogarEmail, password: hogarPassword })
      .expect(200);
    const cookie = getCookie(login);
    expect(
      (login.body as { companies: Array<{ id: string }> }).companies.map(({ id }) => id),
    ).toEqual(["operia-hogar"]);
    expect(login.body).toMatchObject({ role: { name: "ADMIN" } });
    expect(new Set((login.body as { permissions: string[] }).permissions)).toEqual(
      new Set(ALL_PERMISSIONS),
    );
    const forbiddenCompany = await httpCall(app, "put", "/session/company/operia-central")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .expect(404);
    expectApiError(forbiddenCompany, "not_found");

    const wrongPassword = await httpCall(app, "post", "/auth/login")
      .send({ email: demoEmail, password: "wrong-password" })
      .expect(401);
    const unknownUser = await httpCall(app, "post", "/auth/login")
      .send({ email: "not-a-user@operia.local", password: "wrong-password" })
      .expect(401);
    expect(expectApiError(wrongPassword, "unauthenticated").error.message).toBe(
      expectApiError(unknownUser, "unauthenticated").error.message,
    );
  });

  it("expires sessions, invalidates logout, and allows repeated logout", async () => {
    const login = await httpCall(app, "post", "/auth/login")
      .send({ email: hogarEmail, password: hogarPassword })
      .expect(200);
    const cookie = getCookie(login);
    const token = cookie.split("=")[1];
    if (!token) throw new Error("La cookie no contiene el token esperado.");
    const tokenHash = hashSessionToken(decodeURIComponent(token));
    await database.session.update({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = await httpCall(app, "get", "/auth/me").set("Cookie", cookie).expect(401);
    expectApiError(expired, "unauthenticated");
    await expect(database.session.findUnique({ where: { tokenHash } })).resolves.toBeNull();

    const freshLogin = await httpCall(app, "post", "/auth/login")
      .send({ email: hogarEmail, password: hogarPassword })
      .expect(200);
    const freshCookie = getCookie(freshLogin);
    await httpCall(app, "post", "/auth/logout")
      .set("Cookie", freshCookie)
      .set("Origin", "http://localhost:3000")
      .expect(204);
    await httpCall(app, "post", "/auth/logout")
      .set("Cookie", freshCookie)
      .set("Origin", "http://localhost:3000")
      .expect(204);
    const loggedOut = await httpCall(app, "get", "/auth/me").set("Cookie", freshCookie).expect(401);
    expectApiError(loggedOut, "unauthenticated");
  });

  it("expires inactive sessions, refreshes active sessions, and honors disabled inactivity", async () => {
    const previousIdleMinutes = env.SESSION_IDLE_MINUTES;
    env.SESSION_IDLE_MINUTES = 60;
    try {
      const inactiveCookie = await loginAs(hogarEmail, hogarPassword);
      const inactiveToken = inactiveCookie.split("=")[1];
      if (!inactiveToken) throw new Error("La cookie no contiene el token esperado.");
      const inactiveHash = hashSessionToken(decodeURIComponent(inactiveToken));
      await database.session.update({
        where: { tokenHash: inactiveHash },
        data: { lastSeenAt: new Date(Date.now() - 61 * 60_000) },
      });

      const inactive = await httpCall(app, "get", "/auth/me")
        .set("Cookie", inactiveCookie)
        .expect(401);
      expectApiError(inactive, "unauthenticated");
      const inactiveSetCookie = inactive.headers["set-cookie"];
      const inactiveCookieHeaders = Array.isArray(inactiveSetCookie)
        ? inactiveSetCookie
        : [inactiveSetCookie];
      expect(inactiveCookieHeaders).toEqual(
        expect.arrayContaining([expect.stringContaining("operia_session=;")]),
      );
      await expect(
        database.session.findUnique({ where: { tokenHash: inactiveHash } }),
      ).resolves.toBeNull();

      const activeCookie = await loginAs(hogarEmail, hogarPassword);
      const activeToken = activeCookie.split("=")[1];
      if (!activeToken) throw new Error("La cookie no contiene el token esperado.");
      const activeHash = hashSessionToken(decodeURIComponent(activeToken));
      const beforeRefresh = new Date(Date.now() - 2 * 60_000);
      await database.session.update({
        where: { tokenHash: activeHash },
        data: { lastSeenAt: beforeRefresh },
      });
      await httpCall(app, "get", "/auth/me").set("Cookie", activeCookie).expect(200);
      const refreshed = await database.session.findUnique({ where: { tokenHash: activeHash } });
      expect(refreshed?.lastSeenAt.getTime()).toBeGreaterThan(beforeRefresh.getTime());

      env.SESSION_IDLE_MINUTES = 0;
      await database.session.update({
        where: { tokenHash: activeHash },
        data: { lastSeenAt: new Date(Date.now() - 24 * 60 * 60_000) },
      });
      await httpCall(app, "get", "/auth/me").set("Cookie", activeCookie).expect(200);
      await expect(
        database.session.findUnique({ where: { tokenHash: activeHash } }),
      ).resolves.not.toBeNull();
    } finally {
      env.SESSION_IDLE_MINUTES = previousIdleMinutes;
    }
  });

  it("logout-all invalidates every session of one user and leaves other users signed in", async () => {
    const demoCookieOne = await loginAs(demoEmail, demoPassword);
    const demoCookieTwo = await loginAs(demoEmail, demoPassword);
    const hogarCookie = await loginAs(hogarEmail, hogarPassword);

    const closed = await httpCall(app, "post", "/auth/logout-all")
      .set("Cookie", demoCookieOne)
      .set("Origin", "http://localhost:3000")
      .expect(204);
    const setCookie = closed.headers["set-cookie"];
    const cookieHeaders = Array.isArray(setCookie) ? setCookie : [setCookie];
    expect(cookieHeaders).toEqual(
      expect.arrayContaining([expect.stringContaining("operia_session=;")]),
    );

    const firstInvalidated = await httpCall(app, "get", "/auth/me")
      .set("Cookie", demoCookieOne)
      .expect(401);
    expectApiError(firstInvalidated, "unauthenticated");
    const secondInvalidated = await httpCall(app, "get", "/auth/me")
      .set("Cookie", demoCookieTwo)
      .expect(401);
    expectApiError(secondInvalidated, "unauthenticated");
    await httpCall(app, "get", "/auth/me").set("Cookie", hogarCookie).expect(200);

    const noSession = await httpCall(app, "post", "/auth/logout-all")
      .set("Origin", "http://localhost:3000")
      .expect(401);
    expectApiError(noSession, "unauthenticated");
  });

  it("rejects untrusted origins and unknown login fields with the shared error format", async () => {
    const validation = await httpCall(app, "post", "/auth/login")
      .set("Origin", "http://localhost:3000")
      .send({ email: "demo@operia.local", password: "some-password", companyId: "operia-hogar" })
      .expect(400);
    expectApiError(validation, "validation");

    const forbidden = await httpCall(app, "post", "/auth/logout")
      .set("Origin", "https://attacker.invalid")
      .expect(403);
    expectApiError(forbidden, "forbidden");
  });

  it("limits attempts by normalized email and IP", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await httpCall(app, "post", "/auth/login")
        .send({ email: "rate-limit@operia.local", password: "incorrect-password" })
        .expect(401);
    }
    const blocked = await httpCall(app, "post", "/auth/login")
      .send({ email: " RATE-LIMIT@operia.local ", password: "incorrect-password" })
      .expect(429);
    expectApiError(blocked, "rate_limited");
  });

  it("creates, reads, filters, updates, changes status, and deactivates customers", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const input = { ...customerInput("Fase D", "30-11111111-8"), city: "Rosario" };
    const created = await httpCall(app, "post", "/customers")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send(input)
      .expect(201);
    const customer = created.body as CustomerResponse;
    expect(customer.companyId).toBe("operia-central");
    expect(customer.documentNumber).toBe("30-11111111-8");
    expect(customer.personType).toBe("Jurídica");
    expect(customer.documentType).toBe("CUIT/CUIL");
    expect(customer).not.toHaveProperty("movements");

    const read = await httpCall(app, "get", `/customers/${customer.id}`)
      .set("Cookie", cookie)
      .expect(200);
    expect((read.body as CustomerResponse).id).toBe(customer.id);

    const byName = await httpCall(app, "get", "/customers?search=COMPANIA")
      .set("Cookie", cookie)
      .expect(200);
    expect(
      (byName.body as { items: CustomerResponse[] }).items.some(({ id }) => id === customer.id),
    ).toBe(true);
    const byCuit = await httpCall(app, "get", "/customers?search=30111111118&status=active")
      .set("Cookie", cookie)
      .expect(200);
    expect((byCuit.body as { items: CustomerResponse[] }).items.map(({ id }) => id)).toContain(
      customer.id,
    );
    const inactive = await httpCall(app, "get", "/customers?status=inactive")
      .set("Cookie", cookie)
      .expect(200);
    expect(
      (inactive.body as { items: CustomerResponse[] }).items.map(({ id }) => id),
    ).not.toContain(customer.id);

    const inputWithoutCity = omitCity(input);
    const updatedInput = { ...inputWithoutCity, commercialName: "Compañía Editada" };
    const updated = await httpCall(app, "patch", `/customers/${customer.id}`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send(updatedInput)
      .expect(200);
    expect((updated.body as CustomerResponse).commercialName).toBe("Compañía Editada");
    expect((updated.body as CustomerResponse).city).toBe("Rosario");

    const statusChanged = await httpCall(app, "patch", `/customers/${customer.id}/status`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ status: "inactive" })
      .expect(200);
    expect((statusChanged.body as CustomerResponse).status).toBe("inactive");
    const reactivated = await httpCall(app, "patch", `/customers/${customer.id}/status`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ status: "active" })
      .expect(200);
    expect((reactivated.body as CustomerResponse).status).toBe("active");

    const deactivated = await httpCall(app, "post", `/customers/${customer.id}/deactivation`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .expect(201);
    expect((deactivated.body as CustomerResponse).status).toBe("inactive");
  });

  it("supports physical documents, rejects invalid combinations, and enforces document uniqueness", async () => {
    const centralCookie = await loginAs(demoEmail, demoPassword);
    const physicalInput = {
      ...customerInput("Física DNI", "30.123.456"),
      address: "",
      city: "",
      commercialName: "",
      contactEmail: "",
      contactName: "",
      contactPhone: "1123456789",
      documentType: "DNI",
      fiscalAddress: "",
      legalName: "E2E María Pérez",
      locality: "",
      personType: "Física",
      postalCode: "",
      priceList: "Minorista",
      province: "",
      vatCondition: "Consumidor final",
    } as const;
    const accepted = await httpCall(app, "post", "/customers")
      .set("Cookie", centralCookie)
      .set("Origin", "http://localhost:3000")
      .send(physicalInput)
      .expect(201);
    expect(accepted.body).toMatchObject({
      documentNumber: "30123456",
      documentType: "DNI",
      personType: "Física",
      legalName: "E2E María Pérez",
      commercialName: "E2E María Pérez",
    });

    const noContact = await httpCall(app, "post", "/customers")
      .set("Cookie", centralCookie)
      .set("Origin", "http://localhost:3000")
      .send({ ...physicalInput, documentNumber: "30.123.457", contactPhone: "" })
      .expect(400);
    expect(expectApiError(noContact, "validation").error.fieldErrors).toHaveProperty(
      "contactPhone",
    );

    const legalWithDni = await httpCall(app, "post", "/customers")
      .set("Cookie", centralCookie)
      .set("Origin", "http://localhost:3000")
      .send({ ...physicalInput, personType: "Jurídica" })
      .expect(400);
    expect(expectApiError(legalWithDni, "validation").error.fieldErrors).toHaveProperty(
      "documentType",
    );

    const duplicate = await httpCall(app, "post", "/customers")
      .set("Cookie", centralCookie)
      .set("Origin", "http://localhost:3000")
      .send({ ...physicalInput, legalName: "Duplicado" })
      .expect(409);
    expect(expectApiError(duplicate, "conflict").error.fieldErrors).toHaveProperty(
      "documentNumber",
    );

    const sameNumberOtherType = await httpCall(app, "post", "/customers")
      .set("Cookie", centralCookie)
      .set("Origin", "http://localhost:3000")
      .send({ ...physicalInput, documentType: "Pasaporte", documentNumber: "30123456" })
      .expect(201);
    expect((sameNumberOtherType.body as CustomerResponse).documentType).toBe("Pasaporte");
  });

  it("returns pre-migration customers as legal CUIT/CUIL customers", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const response = await httpCall(app, "get", "/customers/distribuidora-norte")
      .set("Cookie", cookie)
      .expect(200);
    expect(response.body).toMatchObject({
      personType: "Jurídica",
      documentType: "CUIT/CUIL",
      documentNumber: "30-71458963-2",
    });
  });

  it("rejects invalid CUIT check digits and permits the same CUIT in another company", async () => {
    const centralCookie = await loginAs(demoEmail, demoPassword);
    const validInput = customerInput("CUIT", "30-22222222-9");
    const invalid = await httpCall(app, "post", "/customers")
      .set("Cookie", centralCookie)
      .set("Origin", "http://localhost:3000")
      .send({ ...validInput, documentNumber: "30-22222222-0" })
      .expect(400);
    expect(expectApiError(invalid, "validation").error.fieldErrors).toHaveProperty(
      "documentNumber",
    );

    const created = await httpCall(app, "post", "/customers")
      .set("Cookie", centralCookie)
      .set("Origin", "http://localhost:3000")
      .send(validInput)
      .expect(201);
    const hogarCookie = await loginAs(hogarEmail, hogarPassword);
    const otherCompany = await httpCall(app, "post", "/customers")
      .set("Cookie", hogarCookie)
      .set("Origin", "http://localhost:3000")
      .send({ ...validInput, contactEmail: "e2e+hogar@e2e.operia.invalid" })
      .expect(201);
    expect((otherCompany.body as CustomerResponse).companyId).toBe("operia-hogar");
    expect((created.body as CustomerResponse).companyId).toBe("operia-central");
  });

  it("hides other companies' customers from reads, edits, deactivation, and list results", async () => {
    const centralCookie = await loginAs(demoEmail, demoPassword);
    const hogarCustomerId = "punto-hogar";
    const missing = await httpCall(app, "get", `/customers/${hogarCustomerId}`)
      .set("Cookie", centralCookie)
      .expect(404);
    expectApiError(missing, "not_found");

    const edit = await httpCall(app, "patch", `/customers/${hogarCustomerId}`)
      .set("Cookie", centralCookie)
      .set("Origin", "http://localhost:3000")
      .send(customerInput("No autorizado", "30-33333333-9"))
      .expect(404);
    expectApiError(edit, "not_found");
    const deactivate = await httpCall(app, "post", `/customers/${hogarCustomerId}/deactivation`)
      .set("Cookie", centralCookie)
      .set("Origin", "http://localhost:3000")
      .expect(404);
    expectApiError(deactivate, "not_found");

    const hogarCookie = await loginAs(hogarEmail, hogarPassword);
    const hogarCustomers = await httpCall(app, "get", "/customers")
      .set("Cookie", hogarCookie)
      .expect(200);
    const ids = (hogarCustomers.body as { items: CustomerResponse[] }).items.map(({ id }) => id);
    expect(ids).toContain(hogarCustomerId);
    expect(ids).not.toContain("distribuidora-norte");
  });

  async function loginAs(email: string, password: string): Promise<string> {
    const response = await httpCall(app, "post", "/auth/login")
      .send({ email, password })
      .expect(200);
    return getCookie(response);
  }

  async function cleanTestData(): Promise<void> {
    if (!database) return;
    await database.session.deleteMany();
    await database.customer.deleteMany({
      where: {
        OR: [{ email: { endsWith: "@e2e.operia.invalid" } }, { legalName: { startsWith: "E2E " } }],
      },
    });
  }
});

function omitCity<T extends { city?: string }>(value: T): Omit<T, "city"> {
  const result = { ...value };
  delete result.city;
  return result;
}
