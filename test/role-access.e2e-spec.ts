import "dotenv/config";
import "./setup-env.js";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { normalizeSearch } from "../src/common/search.js";
import { DatabaseService } from "../src/database/database.service.js";
import { createTestCustomer } from "./helpers/customers.js";
import { ensureProductCategory } from "./helpers/categories.js";
import { adminRoleId } from "./roles.helpers.js";

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

const forbiddenEs = "No tenés permiso para realizar esta acción.";
const forbiddenEn = "You do not have permission to perform this action.";
const lastAdminEs = "La empresa debe conservar al menos un administrador.";
const lastAdminEn = "The company must keep at least one administrator.";
const selfRemovalEs = "No podés quitarte tu propia membresía.";
const selfRemovalEn = "You cannot remove your own membership.";
const roleInUseEs = "No se puede borrar un rol que tiene usuarios asignados.";
const roleInUseEn = "A role assigned to users cannot be deleted.";
const systemRoleEs = "Los roles de sistema no se pueden editar ni borrar.";
const systemRoleEn = "System roles cannot be edited or deleted.";
const password = "role-access-e2e-password";

describe("Acceso por rol (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  const companyId = `e2e-role-access-${randomUUID()}`;
  const safeguardCompanyId = `e2e-role-safeguards-${randomUUID()}`;
  const companyIds = [companyId, safeguardCompanyId];
  const userIds: string[] = [];
  let adminCookie: string;
  let secondAdminCookie: string;
  let billingCookie: string;
  let customersCookie: string;
  let managerCookie: string;
  let adminId: string;
  let secondAdminId: string;
  let customersId: string;
  let safeguardAdminId: string;
  let safeguardAdminCookie: string;
  let billingRoleId: string;
  let customersRoleId: string;
  let safeguardOtherRoleId: string;
  let managerRoleId: string;
  let customerId: string;
  let productId: string;
  let documentId: string;

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttpSecurity(app);
    database = app.get(DatabaseService);
    await app.init();

    await Promise.all(
      companyIds.map((id) => database.company.create({ data: { id, legalName: id, name: id } })),
    );
    const [adminRole, safeguardAdminRole] = await Promise.all([
      adminRoleId(database, companyId),
      adminRoleId(database, safeguardCompanyId),
    ]);
    billingRoleId = (
      await database.role.create({
        data: {
          companyId,
          name: "Facturación",
          permissions: ["documents.read", "documents.write", "documents.cancel"],
          isSystem: false,
        },
        select: { id: true },
      })
    ).id;
    customersRoleId = (
      await database.role.create({
        data: { companyId, name: "Solo clientes", permissions: ["customers.read"] },
        select: { id: true },
      })
    ).id;
    safeguardOtherRoleId = (
      await database.role.create({
        data: { companyId: safeguardCompanyId, name: "Operador", permissions: [] },
        select: { id: true },
      })
    ).id;
    managerRoleId = (
      await database.role.create({
        data: {
          companyId: safeguardCompanyId,
          name: "Gestión de usuarios",
          permissions: ["users.manage"],
        },
        select: { id: true },
      })
    ).id;

    const admin = await createUser("ADMIN", companyId, adminRole);
    const secondAdmin = await createUser("Segundo ADMIN", companyId, adminRole);
    const billing = await createUser("Facturación", companyId, billingRoleId);
    const customers = await createUser("Solo clientes", companyId, customersRoleId);
    const safeguardAdmin = await createUser(
      "ADMIN de salvaguardas",
      safeguardCompanyId,
      safeguardAdminRole,
    );
    const manager = await createUser("Gestor sin rol ADMIN", safeguardCompanyId, managerRoleId);
    adminId = admin.id;
    secondAdminId = secondAdmin.id;
    customersId = customers.id;
    safeguardAdminId = safeguardAdmin.id;
    [adminCookie, secondAdminCookie, billingCookie, customersCookie] = await Promise.all([
      login(admin.email),
      login(secondAdmin.email),
      login(billing.email),
      login(customers.email),
    ]);
    [safeguardAdminCookie, managerCookie] = await Promise.all([
      login(safeguardAdmin.email),
      login(manager.email),
    ]);

    const customer = await createCustomer();
    customerId = customer.id;
    const product = await createProduct();
    productId = product.id;
  });

  afterAll(async () => {
    if (database) {
      const docs = await database.document.findMany({
        where: { companyId },
        select: { id: true },
      });
      const docIds = docs.map(({ id }) => id);
      if (docIds.length) {
        await database.documentItem.deleteMany({ where: { documentId: { in: docIds } } });
        await database.stockMovement.deleteMany({ where: { documentId: { in: docIds } } });
        await database.document.deleteMany({ where: { id: { in: docIds } } });
      }
      if (productId) {
        await database.stockMovement.deleteMany({ where: { productId } });
        await database.product.deleteMany({ where: { id: productId } });
      }
      if (customerId) await database.customer.deleteMany({ where: { id: customerId, companyId } });
      await database.session.deleteMany({ where: { userId: { in: userIds } } });
      await database.membership.deleteMany({ where: { userId: { in: userIds } } });
      await database.user.deleteMany({ where: { id: { in: userIds } } });
      await database.role.deleteMany({ where: { companyId: { in: companyIds } } });
      await database.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await app?.close();
  });

  it("permite al ADMIN consultar los módulos de la empresa", async () => {
    for (const path of [
      "/customers",
      "/products",
      "/documents",
      "/inventory/summary",
      "/cash/sessions/current",
      "/dashboard/summary",
      "/users",
      "/roles",
    ]) {
      await call("get", path, adminCookie).expect(200);
    }
    await call("get", "/customers", secondAdminCookie).expect(200);
  });

  it("permite facturar y deniega módulos ajenos con el mismo error en ambos idiomas", async () => {
    const created = await call("post", "/documents", billingCookie, {
      customerId,
      items: [{ productId, quantity: 1, unitPriceCents: 1000, discountRate: 0, taxRate: 0 }],
    })
      .set("Origin", "http://localhost:3000")
      .set("Idempotency-Key", `role-access-${randomUUID()}`)
      .expect(201);
    documentId = created.body.id as string;
    for (const path of ["/customers", "/products", "/documents", `/documents/${documentId}`])
      await call("get", path, billingCookie).expect(200);
    await call("post", `/documents/${documentId}/cancellation`, billingCookie, {
      reason: "Anulación de prueba",
    })
      .set("Origin", "http://localhost:3000")
      .expect(201);

    for (const [method, path, body] of [
      ["get", "/cash/sessions/current"],
      ["post", "/cash/sessions", {}],
      ["get", "/inventory/summary"],
      ["get", "/stock-movements"],
      ["get", "/users"],
      ["get", "/roles"],
      ["post", "/roles", { name: "No permitido", permissions: [] }],
      ["get", "/dashboard/summary"],
    ] as const) {
      await expectLocalizedError(
        () => call(method, path, billingCookie, body).set("Origin", "http://localhost:3000"),
        403,
        "forbidden",
        forbiddenEs,
        forbiddenEn,
      );
    }
  });

  it("permite leer clientes y bloquea operaciones sin permiso antes de modificar datos", async () => {
    await call("get", "/customers", customersCookie).expect(200);
    await call("get", `/customers/${customerId}`, customersCookie).expect(200);
    const customerWhere = { id_companyId: { id: customerId, companyId } };
    const before = await database.customer.findUniqueOrThrow({ where: customerWhere });

    for (const [method, path, body] of [
      ["post", "/customers", {}],
      ["patch", `/customers/${customerId}`, { commercialName: "Cambio no autorizado" }],
      ["patch", `/customers/${customerId}/status`, { status: "INACTIVE" }],
      ["post", `/customers/${customerId}/deactivation`, {}],
      ["get", "/products"],
      ["get", "/documents"],
      ["post", "/documents", { customerId, items: [] }],
    ] as const) {
      await expectLocalizedError(
        () => call(method, path, customersCookie, body).set("Origin", "http://localhost:3000"),
        403,
        "forbidden",
        forbiddenEs,
        forbiddenEn,
      );
    }
    expect(await database.customer.findUniqueOrThrow({ where: customerWhere })).toEqual(before);
  });

  it("aplica el cambio de rol al siguiente pedido de la misma cookie", async () => {
    // Facturación no sirve: documents.write también permite leer clientes (regla de comprobantes).
    const noAccessRoleId = (
      await database.role.create({ data: { companyId, name: "Sin acceso", permissions: [] } })
    ).id;
    await call("get", "/customers", customersCookie).expect(200);
    await call("patch", `/users/${customersId}`, adminCookie, { roleId: noAccessRoleId })
      .set("Origin", "http://localhost:3000")
      .expect(200);
    await expectLocalizedError(
      () => call("get", "/customers", customersCookie),
      403,
      "forbidden",
      forbiddenEs,
      forbiddenEn,
    );

    await call("patch", `/users/${customersId}`, adminCookie, { roleId: customersRoleId })
      .set("Origin", "http://localhost:3000")
      .expect(200);
    await call("get", "/customers", customersCookie).expect(200);
  });

  it("protege la administración y los roles de sistema en español e inglés", async () => {
    for (const [method, path, body, messageEs, messageEn] of [
      [
        "patch",
        `/users/${safeguardAdminId}`,
        { roleId: safeguardOtherRoleId },
        lastAdminEs,
        lastAdminEn,
      ],
      ["delete", `/users/${safeguardAdminId}`, undefined, selfRemovalEs, selfRemovalEn],
    ] as const) {
      await expectLocalizedError(
        () => call(method, path, safeguardAdminCookie, body).set("Origin", "http://localhost:3000"),
        422,
        "business_rule",
        messageEs,
        messageEn,
      );
    }

    await expectLocalizedError(
      () =>
        call("delete", `/users/${safeguardAdminId}`, managerCookie).set(
          "Origin",
          "http://localhost:3000",
        ),
      422,
      "business_rule",
      lastAdminEs,
      lastAdminEn,
    );
    await expectLocalizedError(
      () =>
        call("delete", `/roles/${billingRoleId}`, adminCookie).set(
          "Origin",
          "http://localhost:3000",
        ),
      409,
      "conflict",
      roleInUseEs,
      roleInUseEn,
    );
    const systemRoleId = await adminRoleId(database, companyId);
    for (const [method, path, body] of [
      ["patch", `/roles/${systemRoleId}`, { name: "ADMIN modificado" }],
      ["delete", `/roles/${systemRoleId}`],
    ] as const) {
      await expectLocalizedError(
        () => call(method, path, adminCookie, body).set("Origin", "http://localhost:3000"),
        409,
        "conflict",
        systemRoleEs,
        systemRoleEn,
      );
    }
  });

  it("serializa cambios concurrentes del rol ADMIN y conserva al menos un ADMIN", async () => {
    const responses = await Promise.all([
      call("patch", `/users/${secondAdminId}`, adminCookie, { roleId: billingRoleId }).set(
        "Origin",
        "http://localhost:3000",
      ),
      call("patch", `/users/${adminId}`, adminCookie, { roleId: billingRoleId }).set(
        "Origin",
        "http://localhost:3000",
      ),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 422]);
    const rejected = responses.find(({ status }) => status === 422);
    expect(rejected?.body.error.code).toBe("business_rule");
    const adminMemberships = await database.membership.count({
      where: { companyId, role: { name: "ADMIN" } },
    });
    expect(adminMemberships).toBeGreaterThanOrEqual(1);
  });

  async function createUser(name: string, userCompanyId: string, roleId: string) {
    const user = await database.user.create({
      data: {
        email: `${randomUUID()}@e2e.operia.invalid`,
        name,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        memberships: { create: { companyId: userCompanyId, roleId } },
      },
      select: { id: true, email: true },
    });
    userIds.push(user.id);
    return user;
  }

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password })
      .expect(200);
    const header = response.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0] : header;
    if (!cookie) throw new Error("El login no creó la cookie de sesión.");
    return cookie.split(";")[0]!;
  }

  async function createCustomer() {
    const suffix = randomUUID();
    return createTestCustomer(database, {
      data: {
        companyId,
        documentNumber: calculateCuit("3012345678"),
        legalName: `Cliente ${suffix}`,
        commercialName: `Cliente ${suffix}`,
        contactName: "Prueba E2E",
        email: `${suffix}@e2e.operia.invalid`,
        phone: "11111111",
        address: "Calle E2E 1",
        city: "Buenos Aires",
        fiscalAddress: "Calle E2E 1",
        locality: "Centro",
        postalCode: "1000",
        province: "Buenos Aires",
        priceList: "General",
        status: "ACTIVE",
        vatCondition: "FINAL_CONSUMER",
      },
      select: { id: true, companyId: true },
    });
  }

  async function createProduct() {
    const suffix = randomUUID();
    const name = `Producto ${suffix}`;
    const sku = `ROLE-${suffix}`;
    return database.product.create({
      data: {
        companyId,
        sku,
        barcode: "",
        name,
        categoryId: await ensureProductCategory(database, companyId),
        unit: "unidad",
        costCents: 100,
        priceCents: 1000,
        minimumStock: 0,
        stockOnHand: 5,
        status: "ACTIVE",
        searchText: normalizeSearch(`${name} ${sku}`),
        nameNormalized: normalizeSearch(name),
      },
      select: { id: true },
    });
  }

  function call(
    method: "get" | "post" | "patch" | "delete",
    path: string,
    cookie: string,
    body?: object,
  ) {
    const agent = request(app.getHttpServer());
    const pending = agent[method](path).set("Cookie", cookie);
    return body ? pending.send(body) : pending;
  }

  async function expectLocalizedError(
    makeRequest: () => ReturnType<typeof call>,
    status: number,
    code: string,
    spanishMessage: string,
    englishMessage: string,
  ) {
    const spanish = await makeRequest().set("Accept-Language", "es").expect(status);
    const english = await makeRequest().set("Accept-Language", "en").expect(status);
    expect(spanish.body.error).toMatchObject({ code, message: spanishMessage });
    expect(english.body.error).toMatchObject({ code, message: englishMessage });
    expect(spanish.status).toBe(english.status);
    expect(spanish.body.error.code).toBe(english.body.error.code);
    expect(spanish.body.error.message).not.toBe(english.body.error.message);
  }
});

function calculateCuit(base: string): string {
  const digits = base.slice(0, 10);
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const rest =
    11 - (weights.reduce((sum, weight, index) => sum + Number(digits[index]) * weight, 0) % 11);
  const check = rest === 11 ? 0 : rest === 10 ? 9 : rest;
  return `${digits}${check}`;
}
