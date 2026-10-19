import "dotenv/config";
import "./setup-env.js";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth.service.js";
import { hashSessionToken } from "../src/auth/session-token.js";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { DatabaseService } from "../src/database/database.service.js";
import { ALL_PERMISSIONS } from "../src/permissions/permissions.catalog.js";
import { adminRoleId } from "./roles.helpers.js";

type Fixture = { companyId: string; userId: string; token: string };

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("Permisos de sesión (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let auth: AuthService;
  let fixture: Fixture;

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttpSecurity(app);
    database = app.get(DatabaseService);
    auth = app.get(AuthService);
    await app.init();
    fixture = await createFixture();
  });

  afterAll(async () => {
    if (fixture) {
      await database.session.deleteMany({ where: { userId: fixture.userId } });
      await database.membership.deleteMany({ where: { userId: fixture.userId } });
      await database.role.deleteMany({ where: { companyId: fixture.companyId } });
      await database.company.deleteMany({ where: { id: fixture.companyId } });
      await database.user.deleteMany({ where: { id: fixture.userId } });
    }
    await app?.close();
  });

  it("recalcula permisos por membresía y elimina la sesión al borrar la membresía", async () => {
    const admin = await auth.authenticate(fixture.token);
    expect(admin.permissions).toEqual(ALL_PERMISSIONS);

    const limitedRole = await database.role.findUniqueOrThrow({
      where: { companyId_name: { companyId: fixture.companyId, name: "SOLO_CLIENTES" } },
      select: { id: true },
    });
    await database.membership.update({
      where: { userId_companyId: { userId: fixture.userId, companyId: fixture.companyId } },
      data: { roleId: limitedRole.id },
    });
    const limited = await auth.authenticate(fixture.token);
    expect(limited.permissions).toEqual(["customers.read"]);

    await database.membership.delete({
      where: { userId_companyId: { userId: fixture.userId, companyId: fixture.companyId } },
    });
    await expect(auth.authenticate(fixture.token)).rejects.toMatchObject({
      code: "unauthenticated",
      status: 401,
    });
    await expect(
      database.session.findUnique({ where: { tokenHash: hashSessionToken(fixture.token) } }),
    ).resolves.toBeNull();
  });

  async function createFixture(): Promise<Fixture> {
    const companyId = `e2e-auth-permissions-${randomUUID()}`;
    await database.company.create({
      data: { id: companyId, legalName: companyId, name: companyId },
    });
    const roleId = await adminRoleId(database, companyId);
    await database.role.create({
      data: {
        companyId,
        name: "SOLO_CLIENTES",
        isSystem: false,
        permissions: ["customers.read"],
      },
    });
    const password = "e2e-auth-permissions-password";
    const user = await database.user.create({
      data: {
        email: `${randomUUID()}@e2e.operia.invalid`,
        name: "E2E Auth Permissions",
        passwordHash: await argon2.hash(password),
        memberships: { create: { companyId, roleId } },
      },
    });
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: user.email, password })
      .expect(200);
    const header = login.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0] : header;
    const token = cookie?.split(";")[0]?.split("=")[1];
    if (!token) throw new Error("El login no creó la cookie de sesión.");
    return { companyId, userId: user.id, token: decodeURIComponent(token) };
  }
});
