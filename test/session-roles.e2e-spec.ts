import "dotenv/config";
import "./setup-env.js";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { DatabaseService } from "../src/database/database.service.js";
import { ALL_PERMISSIONS } from "../src/permissions/permissions.catalog.js";
import { adminRoleId } from "./roles.helpers.js";

type LoginFixture = { userId: string; companyIds: string[]; cookies: Map<string, string> };

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("Roles en sesión y permisos por ruta (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  const fixtures: LoginFixture[] = [];

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttpSecurity(app);
    database = app.get(DatabaseService);
    await app.init();
  });

  afterAll(async () => {
    const userIds = fixtures.map(({ userId }) => userId);
    const companyIds = [...new Set(fixtures.flatMap(({ companyIds: ids }) => ids))];
    await database.session.deleteMany({ where: { userId: { in: userIds } } });
    await database.membership.deleteMany({ where: { userId: { in: userIds } } });
    await database.user.deleteMany({ where: { id: { in: userIds } } });
    await database.role.deleteMany({ where: { companyId: { in: companyIds } } });
    await database.company.deleteMany({ where: { id: { in: companyIds } } });
    await app?.close();
  });

  it("devuelve el rol y permisos activos al iniciar, consultar y cambiar de empresa", async () => {
    const suffix = randomUUID();
    const companyA = await createCompany(`e2e-roles-a-${suffix}`);
    const companyB = await createCompany(`e2e-roles-b-${suffix}`);
    const adminId = await adminRoleId(database, companyA);
    const limited = await database.role.create({
      data: {
        companyId: companyB,
        name: "Solo clientes",
        isSystem: false,
        permissions: ["customers.read", "permission.unknown"],
      },
    });
    const fixture = await createUser([
      { companyId: companyA, roleId: adminId },
      { companyId: companyB, roleId: limited.id },
    ]);

    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: fixture.email, password: fixture.password })
      .expect(200);
    const cookie = cookieFrom(login);
    expect(login.body).toMatchObject({
      activeCompany: { id: companyA },
      role: { id: adminId, name: "ADMIN" },
    });
    expect(login.body.permissions).toEqual(ALL_PERMISSIONS);

    const current = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Cookie", cookie)
      .expect(200);
    expect(current.body).toEqual(login.body);

    const switched = await request(app.getHttpServer())
      .put(`/session/company/${companyB}`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .expect(200);
    expect(switched.body).toMatchObject({
      activeCompany: { id: companyB },
      role: { id: limited.id, name: "Solo clientes" },
      permissions: ["customers.read"],
    });

    const switchedBack = await request(app.getHttpServer())
      .put(`/session/company/${companyA}`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .expect(200);
    expect(switchedBack.body.role).toEqual({ id: adminId, name: "ADMIN" });
    expect(switchedBack.body.permissions).toEqual(ALL_PERMISSIONS);
  });

  it("aplica permisos HTTP y permite las lecturas auxiliares de comprobantes", async () => {
    const customerReader = await createPermissionUser("customers.read");
    const customerCookies = await loginCookies(customerReader);
    await request(app.getHttpServer())
      .get("/customers")
      .set("Cookie", customerCookies.get(customerReader.companyIds[0]!)!)
      .expect(200);
    const deniedCreate = await request(app.getHttpServer())
      .post("/customers")
      .set("Cookie", customerCookies.get(customerReader.companyIds[0]!)!)
      .set("Accept-Language", "en")
      .send({})
      .expect(403);
    expect(deniedCreate.body.error.code).toBe("forbidden");
    expect(deniedCreate.body.error.message).toBe(
      "You do not have permission to perform this action.",
    );
    await request(app.getHttpServer())
      .get("/cash/sessions/current")
      .set("Cookie", customerCookies.get(customerReader.companyIds[0]!)!)
      .expect(403);

    const documentWriter = await createPermissionUser("documents.write");
    const documentCookies = await loginCookies(documentWriter);
    const cookie = documentCookies.get(documentWriter.companyIds[0]!)!;
    await request(app.getHttpServer()).get("/customers").set("Cookie", cookie).expect(200);
    await request(app.getHttpServer()).get("/products").set("Cookie", cookie).expect(200);
    await request(app.getHttpServer()).get("/documents").set("Cookie", cookie).expect(403);
  });

  async function createCompany(id: string): Promise<string> {
    await database.company.create({ data: { id, legalName: id, name: id } });
    return id;
  }

  async function createUser(memberships: { companyId: string; roleId: string }[]) {
    const password = "session-roles-e2e-password";
    const email = `${randomUUID()}@e2e.operia.invalid`;
    const user = await database.user.create({
      data: {
        email,
        name: "E2E Session Roles",
        passwordHash: await argon2.hash(password),
        memberships: { create: memberships },
      },
    });
    const fixture: LoginFixture = {
      userId: user.id,
      companyIds: memberships.map(({ companyId }) => companyId),
      cookies: new Map(),
    };
    fixtures.push(fixture);
    return { ...fixture, email, password };
  }

  async function createPermissionUser(permission: string) {
    const companyId = await createCompany(`e2e-route-${randomUUID()}`);
    const role = await database.role.create({
      data: { companyId, name: "Permiso de prueba", permissions: [permission], isSystem: false },
    });
    return createUser([{ companyId, roleId: role.id }]);
  }

  async function loginCookies(fixture: {
    email: string;
    password: string;
    companyIds: string[];
  }): Promise<Map<string, string>> {
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: fixture.email, password: fixture.password })
      .expect(200);
    const cookie = cookieFrom(login);
    return new Map(fixture.companyIds.map((companyId) => [companyId, cookie]));
  }

  function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }) {
    const header = response.headers["set-cookie"];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) throw new Error("El login no creó la cookie de sesión.");
    return value.split(";")[0]!;
  }
});
