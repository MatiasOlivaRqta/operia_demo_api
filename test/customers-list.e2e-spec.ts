import "dotenv/config";
import "./setup-env.js";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "../src/generated/prisma/client.js";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { DatabaseService } from "../src/database/database.service.js";
import { withCustomerIndexFields } from "./helpers/customers.js";
import { adminRoleId } from "./roles.helpers.js";

type Fixture = { companyId: string; cookie: string };
type CustomerPage = {
  items: Array<{
    id: string;
    commercialName: string;
    vatCondition: string;
    status: string;
    balanceCents: number;
  }>;
  page: number;
  pageSize: number;
  total: number;
};
type CustomerPayload = {
  address: string;
  city: string;
  commercialName: string;
  contactEmail: string;
  contactName: string;
  contactPhone: string;
  documentNumber: string;
  documentType: "CUIT/CUIL";
  fiscalAddress: string;
  legalName: string;
  locality: string;
  personType: "Jurídica";
  postalCode: string;
  priceList: string;
  province: string;
  status: "active" | "inactive";
  vatCondition: "Consumidor final" | "Exento" | "Monotributista" | "Responsable inscripto";
};

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!testDatabaseUrl || decodeURIComponent(new URL(testDatabaseUrl).pathname) !== "/operia_test")
  throw new Error("Las pruebas E2E requieren DATABASE_URL_TEST apuntando a operia_test.");
process.env.DATABASE_URL = testDatabaseUrl;
const { AppModule } = await import("../src/app.module.js");

describe("Customers list (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let resetRateLimits: () => void;
  let fixture: Fixture;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();
  let sequence = 0;

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
    await database.cashMovement.deleteMany({ where: { companyId: { in: companies } } });
    await database.cashSession.deleteMany({ where: { companyId: { in: companies } } });
    await database.document.deleteMany({ where: { companyId: { in: companies } } });
    await database.customer.deleteMany({ where: { companyId: { in: companies } } });
    await database.session.deleteMany({ where: { userId: { in: users } } });
    await database.membership.deleteMany({ where: { userId: { in: users } } });
    await database.user.deleteMany({ where: { id: { in: users } } });
    await database.company.deleteMany({ where: { id: { in: companies } } });
    companyIds.clear();
    userIds.clear();
    sequence = 0;
  });
  afterAll(async () => app?.close());

  it("returns the default page and its full filtered total", async () => {
    await createCustomers(fixture.companyId, 3_000);
    const page = await list();
    expect(page).toMatchObject({ page: 1, pageSize: 25, total: 3_000 });
    expect(page.items).toHaveLength(25);
  });

  it("returns an intermediate page in normalized name order", async () => {
    await createCustomers(fixture.companyId, 160);
    const page = await list("?page=3&pageSize=50");
    expect(page).toMatchObject({ page: 3, pageSize: 50, total: 160 });
    expect(page.items).toHaveLength(50);
    expect(page.items[0]?.commercialName).toBe("Cliente 0100");
    expect(page.items.at(-1)?.commercialName).toBe("Cliente 0149");
  });

  it("returns an empty page beyond the end with the correct total", async () => {
    await createCustomers(fixture.companyId, 2);
    expect(await list("?page=200&pageSize=1")).toMatchObject({
      items: [],
      page: 200,
      pageSize: 1,
      total: 2,
    });
  });

  it.each(["?pageSize=101", "?page=0"])("rejects invalid pagination %s", async (query) => {
    await request(app.getHttpServer())
      .get(`/customers${query}`)
      .set("Cookie", fixture.cookie)
      .expect(400);
  });

  it("isolates the page and total to the signed-in company", async () => {
    await createCustomers(fixture.companyId, 2);
    const foreign = await createFixture();
    await createCustomers(foreign.companyId, 3);
    const ownPage = await list();
    expect(ownPage.total).toBe(2);
    expect(ownPage.items).toHaveLength(2);
  });

  it("returns balanceCents: all non-cancelled invoices minus collections, per company", async () => {
    await createCustomer(fixture.companyId, { commercialName: "A sin movimientos" });
    const invoiced = await createCustomer(fixture.companyId, { commercialName: "B facturado" });
    const cancelled = await createCustomer(fixture.companyId, { commercialName: "C anulado" });
    const partial = await createCustomer(fixture.companyId, { commercialName: "D cobro parcial" });
    await createDocument(fixture.companyId, invoiced.id, 10_000);
    await createDocument(fixture.companyId, cancelled.id, 7_000, "CANCELLED");
    await createDocument(fixture.companyId, partial.id, 10_000);
    await createCollection(fixture, partial.id, 4_000);

    const foreign = await createFixture();
    const foreignCustomer = await createCustomer(foreign.companyId, { commercialName: "E ajeno" });
    await createDocument(foreign.companyId, foreignCustomer.id, 99_000);

    const balances = Object.fromEntries(
      (await list()).items.map((item) => [item.commercialName, item.balanceCents]),
    );
    expect(balances).toEqual({
      "A sin movimientos": 0,
      "B facturado": 10_000,
      "C anulado": 0,
      "D cobro parcial": 6_000,
    });
  });

  it("filters by status, VAT condition, and their combination with search", async () => {
    await createCustomer(fixture.companyId, {
      commercialName: "Compañía Pérez activa",
      legalName: "Perez activa",
      status: "active",
      vatCondition: "Exento",
    });
    await createCustomer(fixture.companyId, {
      commercialName: "Compañía Pérez inactiva",
      legalName: "Perez inactiva",
      status: "inactive",
      vatCondition: "Exento",
    });
    await createCustomer(fixture.companyId, {
      commercialName: "Compañía Pérez monotributo",
      legalName: "Perez mono",
      status: "active",
      vatCondition: "Monotributista",
    });

    expect(await list("?status=inactive")).toMatchObject({
      total: 1,
      items: [{ status: "inactive" }],
    });
    expect(await list("?vatCondition=Monotributista")).toMatchObject({
      total: 1,
      items: [{ vatCondition: "Monotributista" }],
    });
    expect(await list("?status=active&vatCondition=Exento&search=perez")).toMatchObject({
      total: 1,
      items: [
        { commercialName: "Compañía Pérez activa", status: "active", vatCondition: "Exento" },
      ],
    });
  });

  it("rejects an unknown VAT condition", async () => {
    await request(app.getHttpServer())
      .get("/customers?vatCondition=Otro")
      .set("Cookie", fixture.cookie)
      .expect(400);
  });

  it("searches accent-insensitively and finds a hyphenated CUIT prefix", async () => {
    await createCustomer(fixture.companyId, {
      commercialName: "Compañía Pérez S.R.L.",
      legalName: "Compañía Pérez S.R.L.",
      documentNumber: cuitFor(90_001),
    });
    await createCustomer(fixture.companyId, {
      commercialName: "Cliente CUIT",
      legalName: "Cliente CUIT",
      documentNumber: "20123456786",
    });
    expect((await list("?search=perez")).items.map((item) => item.commercialName)).toContain(
      "Compañía Pérez S.R.L.",
    );
    expect((await list("?search=20-12345")).items.map((item) => item.commercialName)).toContain(
      "Cliente CUIT",
    );
  });

  it("treats percent literally and rejects search longer than 200 characters", async () => {
    await createCustomer(fixture.companyId, { commercialName: "Cliente 100% real" });
    await createCustomer(fixture.companyId, { commercialName: "Cliente 100 real" });
    expect(await list("?search=%25")).toMatchObject({
      total: 1,
      items: [{ commercialName: "Cliente 100% real" }],
    });
    await request(app.getHttpServer())
      .get(`/customers?search=${"a".repeat(201)}`)
      .set("Cookie", fixture.cookie)
      .expect(400);
  });

  it("updates index fields when the commercial name changes", async () => {
    const customer = await createCustomer(fixture.companyId, { commercialName: "Nombre anterior" });
    const payload = customerPayload({ commercialName: "Nombre nuevo" });
    await request(app.getHttpServer())
      .patch(`/customers/${customer.id}`)
      .set("Cookie", fixture.cookie)
      .send(payload)
      .expect(200);
    expect((await list("?search=nuevo")).items.map((item) => item.id)).toContain(customer.id);
    expect((await list("?search=anterior")).items.map((item) => item.id)).not.toContain(
      customer.id,
    );
  });

  it("uses the customer indexes for the service query shapes at 5,000 rows", async () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => {
      const name = `Índice ${String(index).padStart(5, "0")}${index === 2_501 ? " rareclientneedle" : ""}`;
      return withCustomerIndexFields({
        companyId: fixture.companyId,
        documentNumber: cuitFor(index + 1),
        legalName: `Razón ${name}`,
        commercialName: name,
        contactName: "Cliente de rendimiento",
        email: `index-${index}@e2e.operia.invalid`,
        phone: "11111111",
        address: "E2E",
        city: "Buenos Aires",
        fiscalAddress: "E2E",
        locality: "Centro",
        postalCode: "1000",
        province: "Buenos Aires",
        priceList: "General",
        status: index % 2 === 0 ? ("ACTIVE" as const) : ("INACTIVE" as const),
        vatCondition: index % 4 < 2 ? ("FINAL_CONSUMER" as const) : ("EXEMPT" as const),
      });
    });
    for (let start = 0; start < rows.length; start += 500)
      await database.customer.createMany({ data: rows.slice(start, start + 500) });
    // VACUUM vacía la pending list del GIN: sin eso el planner descarta el índice recién cargado.
    await database.$executeRaw`VACUUM ANALYZE customers`;

    const plans = [
      [
        "sin filtros",
        database.$queryRaw<Array<{ "QUERY PLAN": string }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT id, company_id, address, city, commercial_name, contact_email, contact_name,
          contact_phone, document_number, document_type, fiscal_address, legal_name, locality,
          person_type, postal_code, price_list, province, status, vat_condition
        FROM customers WHERE company_id = ${fixture.companyId}
        ORDER BY name_normalized ASC, id ASC LIMIT 25 OFFSET 0`,
      ],
      [
        "status",
        database.$queryRaw<Array<{ "QUERY PLAN": string }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT id, company_id, address, city, commercial_name, contact_email, contact_name,
          contact_phone, document_number, document_type, fiscal_address, legal_name, locality,
          person_type, postal_code, price_list, province, status, vat_condition
        FROM customers WHERE company_id = ${fixture.companyId} AND status = 'ACTIVE'
        ORDER BY name_normalized ASC, id ASC LIMIT 25 OFFSET 0`,
      ],
      [
        "vatCondition",
        database.$queryRaw<Array<{ "QUERY PLAN": string }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT id, company_id, address, city, commercial_name, contact_email, contact_name,
          contact_phone, document_number, document_type, fiscal_address, legal_name, locality,
          person_type, postal_code, price_list, province, status, vat_condition
        FROM customers WHERE company_id = ${fixture.companyId} AND vat_condition = 'EXENTO'
        ORDER BY name_normalized ASC, id ASC LIMIT 25 OFFSET 0`,
      ],
      [
        "search",
        database.$queryRaw<Array<{ "QUERY PLAN": string }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT id, company_id, address, city, commercial_name, contact_email, contact_name,
          contact_phone, document_number, document_type, fiscal_address, legal_name, locality,
          person_type, postal_code, price_list, province, status, vat_condition
        FROM customers WHERE company_id = ${fixture.companyId}
          AND search_text LIKE ${"%rareclientneedle%"}
        ORDER BY name_normalized ASC, id ASC LIMIT 25 OFFSET 0`,
      ],
    ] as const;
    for (const [label, query] of plans) {
      const result = await query;
      const plan = result.map((row) => row["QUERY PLAN"]).join("\n");
      console.info(`EXPLAIN customers (${label}):\n${plan}`);
      expect(plan, `${label} debe evitar Seq Scan sobre customers`).not.toMatch(
        /Seq Scan on customers/i,
      );
      if (label !== "search") expect(plan, `${label} debe evitar Sort`).not.toMatch(/\bSort\b/i);
      else expect(plan).toMatch(/Bitmap Index Scan on customers_search_text_trgm_idx/i);
    }

    const startedAt = performance.now();
    const page = await list();
    const elapsedMs = performance.now() - startedAt;
    expect(page.items).toHaveLength(25);
    expect(page.total).toBe(5_000);
    expect(elapsedMs).toBeLessThan(500);
  }, 60_000);

  async function createFixture(): Promise<Fixture> {
    const companyId = `e2e-customers-list-${randomUUID()}`;
    companyIds.add(companyId);
    await database.company.create({
      data: { id: companyId, legalName: companyId, name: companyId },
    });
    const roleId = await adminRoleId(database, companyId);
    const email = `${randomUUID()}@e2e.operia.invalid`;
    const password = "e2e-customers-list-password";
    const user = await database.user.create({
      data: {
        email,
        name: "E2E Customers List",
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

  async function createDocument(
    companyId: string,
    customerId: string,
    totalCents: number,
    status: "PENDING" | "PARTIAL" | "COMPLETED" | "CANCELLED" = "PENDING",
  ): Promise<void> {
    const key = randomUUID();
    await database.document.create({
      data: {
        companyId,
        customerId,
        customerName: "Snapshot E2E",
        internalNumber: `0001-${String(++sequence).padStart(8, "0")}`,
        pointOfSale: "0001",
        status,
        cancelledAt: status === "CANCELLED" ? new Date() : null,
        totalCents,
        idempotencyKey: key,
        requestFingerprint: key,
        searchText: "E2E",
      },
    });
  }

  async function createCollection(
    owner: Fixture,
    customerId: string,
    amount: number,
  ): Promise<void> {
    const user = await database.membership.findFirstOrThrow({
      where: { companyId: owner.companyId },
      select: { userId: true },
    });
    const session = await database.cashSession.create({
      data: {
        companyId: owner.companyId,
        openedByUserId: user.userId,
        openingBalance: 0,
        status: "OPEN",
      },
    });
    await database.cashMovement.create({
      data: {
        companyId: owner.companyId,
        sessionId: session.id,
        customerId,
        customerName: "E2E",
        type: "COBRO",
        paymentMethod: "TRANSFER",
        receiptNumber: `R-${++sequence}`,
        amount,
      },
    });
  }

  async function createCustomers(companyId: string, count: number): Promise<void> {
    for (let start = 0; start < count; start += 500) {
      const end = Math.min(start + 500, count);
      const rows = Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        return withCustomerIndexFields(
          customerData(companyId, { commercialName: `Cliente ${String(index).padStart(4, "0")}` }),
        );
      });
      await database.customer.createMany({ data: rows });
    }
  }

  async function createCustomer(
    companyId: string,
    overrides: Partial<CustomerPayload> & { documentNumber?: string } = {},
  ) {
    const data = customerData(companyId, overrides);
    return database.customer.create({ data: withCustomerIndexFields(data) });
  }

  function customerData(
    companyId: string,
    overrides: Partial<CustomerPayload> & { documentNumber?: string } = {},
  ): Prisma.CustomerCreateManyInput {
    const index = ++sequence;
    const payload = customerPayload(overrides);
    return {
      companyId,
      documentType: "CUIT",
      personType: "LEGAL",
      documentNumber: overrides.documentNumber ?? cuitFor(index),
      legalName: payload.legalName,
      commercialName: payload.commercialName,
      contactName: payload.contactName,
      email: payload.contactEmail,
      phone: payload.contactPhone,
      address: payload.address,
      city: payload.city,
      fiscalAddress: payload.fiscalAddress,
      locality: payload.locality,
      postalCode: payload.postalCode,
      province: payload.province,
      priceList: payload.priceList,
      status: payload.status === "active" ? "ACTIVE" : "INACTIVE",
      vatCondition:
        payload.vatCondition === "Exento"
          ? "EXEMPT"
          : payload.vatCondition === "Monotributista"
            ? "MONOTRIBUTISTA"
            : payload.vatCondition === "Responsable inscripto"
              ? "REGISTERED_TAXPAYER"
              : "FINAL_CONSUMER",
    };
  }

  function customerPayload(
    overrides: Partial<CustomerPayload> & { documentNumber?: string } = {},
  ): CustomerPayload {
    const index = sequence + 1;
    return {
      address: "Calle E2E 1",
      city: "Buenos Aires",
      commercialName: `Cliente ${index}`,
      contactEmail: `customer-${index}@e2e.operia.invalid`,
      contactName: "Cliente de prueba",
      contactPhone: "11111111",
      documentNumber: cuitFor(index),
      documentType: "CUIT/CUIL",
      fiscalAddress: "Calle E2E 1",
      legalName: `Razón social ${index}`,
      locality: "Centro",
      personType: "Jurídica",
      postalCode: "1000",
      priceList: "General",
      province: "Buenos Aires",
      status: "active",
      vatCondition: "Consumidor final",
      ...overrides,
    };
  }

  async function list(query = ""): Promise<CustomerPage> {
    const response = await request(app.getHttpServer())
      .get(`/customers${query}`)
      .set("Cookie", fixture.cookie)
      .expect(200);
    return response.body as CustomerPage;
  }
});

function cuitFor(sequence: number): string {
  const base = `30${String(sequence).padStart(8, "0")}`;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const remainder =
    11 - (weights.reduce((sum, weight, index) => sum + Number(base[index]) * weight, 0) % 11);
  return `${base}${remainder === 11 ? 0 : remainder === 10 ? 9 : remainder}`;
}
