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
import { adminRoleId } from "./roles.helpers.js";

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("Usuarios y roles (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  const companyIds = [`e2e-users-roles-${randomUUID()}`, `e2e-users-roles-${randomUUID()}`];
  const userIds: string[] = [];
  const credentials: Array<{ email: string; password: string }> = [];
  const tokens: string[] = [];

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttpSecurity(app);
    database = app.get(DatabaseService);
    await app.init();
    await Promise.all(
      companyIds.map((id) => database.company.create({ data: { id, legalName: id, name: id } })),
    );
    for (const companyId of companyIds) await adminRoleId(database, companyId);
    const adminPassword = "e2e-users-roles-admin-password";
    const admin = await createUser(
      companyIds[0]!,
      "Admin de prueba",
      adminPassword,
      companyIds[0]!,
    );
    const otherAdmin = await createUser(
      companyIds[0]!,
      "Segundo admin",
      adminPassword,
      companyIds[0]!,
    );
    await createUser(companyIds[1]!, "Cuenta existente", "existing-password-123", companyIds[1]!);
    userIds.push(admin.id, otherAdmin.id);
    credentials.push(
      { email: admin.email, password: adminPassword },
      { email: otherAdmin.email, password: adminPassword },
    );
    for (const credential of credentials)
      tokens.push(await login(credential.email, credential.password));
  });

  afterAll(async () => {
    if (userIds.length) {
      await database.session.deleteMany({ where: { userId: { in: userIds } } });
      await database.membership.deleteMany({
        where: { userId: { in: userIds }, companyId: { in: companyIds } },
      });
      await database.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await database.membership.deleteMany({ where: { companyId: { in: companyIds } } });
    await database.role.deleteMany({ where: { companyId: { in: companyIds } } });
    await database.company.deleteMany({ where: { id: { in: companyIds } } });
    await app?.close();
  });

  it("crea rol y usuario, respeta contraseña existente y serializa bajas de ADMIN", async () => {
    const roleResponse = await request(app.getHttpServer())
      .post("/roles")
      .set("Cookie", tokens[0]!)
      .send({ name: "Facturación", permissions: ["documents.write"] })
      .expect(201);
    const roleId = roleResponse.body.id as string;
    const newEmail = `${randomUUID()}@e2e.operia.invalid`;
    const created = await request(app.getHttpServer())
      .post("/users")
      .set("Cookie", tokens[0]!)
      .send({ email: newEmail, name: "Pepe", password: "initial-password-123", roleId })
      .expect(201);
    userIds.push(created.body.id as string);
    const loginResponse = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: newEmail, password: "initial-password-123" })
      .expect(200);
    const loginCookie = cookieValue(loginResponse.headers["set-cookie"]);
    await request(app.getHttpServer())
      .get("/auth/me")
      .set("Cookie", loginCookie)
      .expect(200)
      .expect(({ body }) => {
        expect(body.role).toMatchObject({ id: roleId, name: "Facturación" });
        expect(body.permissions).toEqual(["documents.write"]);
      });

    const existing = await database.user.findFirstOrThrow({
      where: {
        email: { endsWith: "@e2e.operia.invalid" },
        name: "Cuenta existente",
        memberships: { some: { companyId: companyIds[1] } },
      },
    });
    const oldHash = existing.passwordHash;
    // Rol no ADMIN: un tercer ADMIN haría legítimas las dos bajas cruzadas de más abajo.
    const existingRoleId = roleId;
    await request(app.getHttpServer())
      .post("/users")
      .set("Cookie", tokens[0]!)
      .set("Accept-Language", "en")
      .send({
        email: existing.email,
        name: "No reemplazar",
        password: "different-password-123",
        roleId: existingRoleId,
      })
      .expect(201);
    expect(
      await database.user.findUniqueOrThrow({
        where: { id: existing.id },
        select: { passwordHash: true, name: true },
      }),
    ).toEqual({ passwordHash: oldHash, name: "Cuenta existente" });
    await request(app.getHttpServer())
      .post("/users")
      .set("Cookie", tokens[0]!)
      .set("Accept-Language", "en")
      .send({
        email: existing.email,
        name: "Duplicate",
        password: "another-password-123",
        roleId: existingRoleId,
      })
      .expect(409)
      .expect(({ body }) => expect(body.error.fieldErrors.email[0]).toContain("already a member"));
    await request(app.getHttpServer())
      .post("/users")
      .set("Cookie", tokens[0]!)
      .set("Accept-Language", "es")
      .send({
        email: existing.email,
        name: "Duplicado",
        password: "another-password-123",
        roleId: existingRoleId,
      })
      .expect(409)
      .expect(({ body }) => expect(body.error.fieldErrors.email[0]).toContain("miembro"));
    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: existing.email, password: "existing-password-123" })
      .expect(200);

    const removals = await Promise.all([
      request(app.getHttpServer()).delete(`/users/${userIds[1]}`).set("Cookie", tokens[0]!),
      request(app.getHttpServer()).delete(`/users/${userIds[0]}`).set("Cookie", tokens[1]!),
    ]);
    expect(removals.filter((response) => response.status === 204)).toHaveLength(1);
    expect(
      await database.membership.count({
        where: { companyId: companyIds[0], role: { name: "ADMIN" } },
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  async function createUser(
    companyId: string,
    name: string,
    password: string,
    roleCompanyId: string,
  ) {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const roleId = await adminRoleId(database, roleCompanyId);
    const user = await database.user.create({
      data: {
        email: `${randomUUID()}@e2e.operia.invalid`,
        name,
        passwordHash,
        memberships: { create: { companyId, roleId } },
      },
    });
    userIds.push(user.id);
    return user;
  }

  async function login(email: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password })
      .expect(200);
    return cookieValue(response.headers["set-cookie"]);
  }
});

function cookieValue(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const cookie = value?.split(";")[0];
  if (!cookie) throw new Error("El login no creó la cookie de sesión.");
  return cookie;
}
