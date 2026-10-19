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
type SubType = { id: string; elemTypeId: string; description: string };
type SubTypePage = { items: SubType[]; page: number; pageSize: number; total: number };

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("Element catalog (e2e)", () => {
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
    await database.elemSubType.deleteMany({ where: { companyId: { in: companies } } });
    await database.session.deleteMany({ where: { userId: { in: users } } });
    await database.membership.deleteMany({ where: { userId: { in: users } } });
    await database.user.deleteMany({ where: { id: { in: users } } });
    await database.company.deleteMany({ where: { id: { in: companies } } });
    companyIds.clear();
    userIds.clear();
  });
  afterAll(async () => app?.close());

  it("has the PROD_CAT type and returns 404 for unknown types", async () => {
    expect(await database.elemType.findUnique({ where: { id: "PROD_CAT" } })).not.toBeNull();
    const response = await request(app.getHttpServer())
      .get("/elem-types/NO_EXISTE/sub-types")
      .set("Cookie", fixture.cookie)
      .expect(404);
    expect(response.body).toMatchObject({ error: { code: "not_found" } });
    await post("NO_EXISTE", { description: "X" }, fixture.cookie).expect(404);
  });

  it("requires products.read to list and products.write to create subtypes", async () => {
    const readCookie = await createRoleCookie(["products.read"]);
    const response = await request(app.getHttpServer())
      .get("/elem-types/PROD_CAT/sub-types")
      .set("Cookie", readCookie)
      .expect(200);
    expect(response.body).toMatchObject({ items: expect.any(Array) });
    const readOnlyCreate = await post(
      "PROD_CAT",
      { description: `No permitido ${randomUUID()}` },
      readCookie,
    ).expect(403);
    expect(readOnlyCreate.body).toMatchObject({ error: { code: "forbidden" } });

    const noPermissionsCookie = await createRoleCookie([]);
    for (const send of [
      () => request(app.getHttpServer()).get("/elem-types/PROD_CAT/sub-types"),
      () => post("PROD_CAT", { description: `No permitido ${randomUUID()}` }, noPermissionsCookie),
    ]) {
      const response = await send().set("Cookie", noPermissionsCookie).expect(403);
      expect(response.body).toMatchObject({ error: { code: "forbidden" } });
    }
    await request(app.getHttpServer())
      .get("/elem-types/PROD_CAT/sub-types")
      .set("Cookie", fixture.cookie)
      .expect(200);
    await post("PROD_CAT", { description: `Permitido ${randomUUID()}` }, fixture.cookie).expect(
      201,
    );
    const writeCookie = await createRoleCookie(["products.write"]);
    await post("PROD_CAT", { description: `Permitido ${randomUUID()}` }, writeCookie).expect(201);
  });

  it("lists, searches accent-insensitively and paginates in description order", async () => {
    for (const description of ["Seguridad", "Ferretería", "Electricidad"])
      await post("PROD_CAT", { description }, fixture.cookie).expect(201);
    const all = await list("");
    expect(all).toMatchObject({ page: 1, pageSize: 25, total: 3 });
    expect(all.items.map((item) => item.description)).toEqual([
      "Electricidad",
      "Ferretería",
      "Seguridad",
    ]);
    expect(all.items[0]).toEqual({
      id: expect.any(String),
      elemTypeId: "PROD_CAT",
      description: "Electricidad",
    });
    expect(await list("?search=ELEC")).toMatchObject({
      total: 1,
      items: [{ description: "Electricidad" }],
    });
    expect((await list("?search=ferreter%C3%ADa")).items).toHaveLength(1);
    expect(await list("?page=2&pageSize=2")).toMatchObject({
      page: 2,
      pageSize: 2,
      total: 3,
      items: [{ description: "Seguridad" }],
    });
    expect((await list("?search=%25")).total).toBe(0);
  });

  it.each(["?pageSize=101", "?page=0"])("rejects invalid pagination %s", async (query) => {
    await request(app.getHttpServer())
      .get(`/elem-types/PROD_CAT/sub-types${query}`)
      .set("Cookie", fixture.cookie)
      .expect(400);
  });

  it("isolates companies and gives each its own id for the same description", async () => {
    const own = await post("PROD_CAT", { description: "Herramientas" }, fixture.cookie).expect(201);
    const foreign = await createFixture();
    expect((await list("", foreign.cookie)).total).toBe(0);
    const other = await post("PROD_CAT", { description: "Herramientas" }, foreign.cookie).expect(
      201,
    );
    expect((other.body as SubType).id).not.toBe((own.body as SubType).id);
    expect((await list("")).total).toBe(1);
  });

  it("creates with 201 and returns the equivalent existing one with 200", async () => {
    const created = await post("PROD_CAT", { description: " Pinturas " }, fixture.cookie).expect(
      201,
    );
    expect(created.body).toEqual({
      id: expect.any(String),
      elemTypeId: "PROD_CAT",
      description: "Pinturas",
    });
    await post("PROD_CAT", { description: "Ferretería" }, fixture.cookie).expect(201);
    const again = await post("PROD_CAT", { description: "  FERRETERIA " }, fixture.cookie).expect(
      200,
    );
    expect((again.body as SubType).description).toBe("Ferretería");
    expect((await list("")).total).toBe(2);
  });

  it("converges concurrent creates of the same category into a single row", async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        post("PROD_CAT", { description: "Pinturas" }, fixture.cookie),
      ),
    );
    expect(new Set(responses.map((response) => (response.body as SubType).id)).size).toBe(1);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(await database.elemSubType.count({ where: { companyId: fixture.companyId } })).toBe(1);
  });

  it.each([{ description: "" }, { description: "   " }, { description: "a".repeat(101) }, {}])(
    "rejects invalid description %j",
    async (body) => {
      const response = await post("PROD_CAT", body, fixture.cookie).expect(400);
      expect(response.body).toMatchObject({ error: { code: "validation" } });
    },
  );

  it("exposes no management routes", async () => {
    const agent = () => request(app.getHttpServer());
    await agent().post("/elem-types").set("Cookie", fixture.cookie).send({}).expect(404);
    await agent()
      .patch("/elem-types/PROD_CAT/sub-types/x")
      .set("Cookie", fixture.cookie)
      .send({ description: "x" })
      .expect(404);
    await agent()
      .delete("/elem-types/PROD_CAT/sub-types/x")
      .set("Cookie", fixture.cookie)
      .expect(404);
  });

  function post(typeId: string, body: object, cookie: string) {
    return request(app.getHttpServer())
      .post(`/elem-types/${typeId}/sub-types`)
      .set("Cookie", cookie)
      .send(body);
  }

  async function list(query: string, cookie = fixture.cookie): Promise<SubTypePage> {
    const response = await request(app.getHttpServer())
      .get(`/elem-types/PROD_CAT/sub-types${query}`)
      .set("Cookie", cookie)
      .expect(200);
    return response.body as SubTypePage;
  }

  async function createFixture(): Promise<Fixture> {
    const companyId = `e2e-elem-types-${randomUUID()}`;
    companyIds.add(companyId);
    await database.company.create({
      data: { id: companyId, legalName: companyId, name: companyId },
    });
    const roleId = await adminRoleId(database, companyId);
    const email = `${randomUUID()}@e2e.operia.invalid`;
    const password = "e2e-elem-types-password";
    const user = await database.user.create({
      data: {
        email,
        name: "E2E Elem Types",
        passwordHash: await argon2.hash(password),
        memberships: { create: { companyId, roleId } },
      },
    });
    userIds.add(user.id);
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password })
      .expect(200);
    const header = login.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0] : header;
    if (!cookie) throw new Error("El login no creó la cookie de sesión.");
    return { companyId, cookie: cookie.split(";")[0]! };
  }

  async function createRoleCookie(permissions: string[]): Promise<string> {
    const roleId = await customRoleId(
      database,
      fixture.companyId,
      `E2E ${randomUUID()}`,
      permissions,
    );
    const email = `${randomUUID()}@e2e.operia.invalid`;
    const password = "e2e-elem-types-password";
    const user = await database.user.create({
      data: {
        email,
        name: "E2E role Elem Types",
        passwordHash: await argon2.hash(password),
        memberships: { create: { companyId: fixture.companyId, roleId } },
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
