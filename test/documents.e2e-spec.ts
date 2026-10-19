import "dotenv/config";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { normalizeSearch } from "../src/common/search.js";
import { createTestCustomer } from "./helpers/customers.js";
import { ensureProductCategory } from "./helpers/categories.js";
import { DatabaseService } from "../src/database/database.service.js";

type TestResponse = {
  body: unknown;
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
};
interface TestRequest {
  set(field: string, value: string): TestRequest;
  send(data: object | string): TestRequest;
  expect(status: number | ((response: TestResponse) => void)): Promise<TestResponse>;
}
type DocumentResponse = {
  id: string;
  companyId: string;
  customerId: string;
  customerName: string;
  date: string;
  internalNumber: string;
  pointOfSale: string;
  status: "PENDING" | "PARTIAL" | "COMPLETED" | "CANCELLED";
  cancelledBy?: string;
  totalCents: number;
  itemCount: number;
  items: Array<{
    productId: string;
    productName: string;
    sku: string;
    quantity: number;
    unitPriceCents: number;
    discountRate: number;
    taxRate: number;
  }>;
};
type Page<T> = { items: T[]; page: number; pageSize: number; total: number };
type ProductFixture = { id: string; companyId: string; name: string; sku: string };
type CustomerFixture = { id: string; companyId: string; commercialName: string; email: string };

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

function productInput(
  productId: string,
  quantity = 1,
  overrides: Partial<Record<string, number>> = {},
) {
  return {
    productId,
    quantity,
    unitPriceCents: overrides.unitPriceCents ?? 1000,
    discountRate: overrides.discountRate ?? 0,
    taxRate: overrides.taxRate ?? 0,
  };
}

function calculateCuit(base: string): string {
  const digits = `${base.slice(0, 10)}`;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const rest =
    11 - (weights.reduce((sum, weight, index) => sum + Number(digits[index]) * weight, 0) % 11);
  const check = rest === 11 ? 0 : rest === 10 ? 9 : rest;
  return `${digits}${check}`;
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

describe("Documents (e2e)", () => {
  let app: INestApplication;
  let database: DatabaseService;
  let resetRateLimits: () => void;
  let fixtureSequence = 0;

  beforeAll(async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    resetRateLimits = configureHttpSecurity(app);
    database = app.get(DatabaseService);
    await app.init();
  });
  beforeEach(async () => {
    resetRateLimits();
    await cleanTestData();
  });
  afterEach(async () => cleanTestData());
  afterAll(async () => app?.close());

  it("creates with server snapshots, grouped stock output and server calculated cents", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const customer = await createCustomer("Ventas Álamo", "ACTIVE");
    const product = await createProduct("Taladro Pércutor", 10);
    const created = await createDocument(cookie, "e2e-create-0001", customer.id, [
      productInput(product.id, 2, { unitPriceCents: 5, discountRate: 10, taxRate: 21 }),
      productInput(product.id, 1, { unitPriceCents: 5, discountRate: 10, taxRate: 21 }),
    ]);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      companyId: "operia-central",
      customerName: customer.commercialName,
      internalNumber: expect.stringMatching(/^0001-\d{8}$/),
      pointOfSale: "0001",
      status: "PENDING",
      totalCents: 16,
      itemCount: 2,
      items: [
        { productId: product.id, productName: product.name, sku: product.sku, quantity: 2 },
        { productId: product.id, productName: product.name, sku: product.sku, quantity: 1 },
      ],
    });
    const stock = await database.product.findUniqueOrThrow({
      where: { id_companyId: { id: product.id, companyId: product.companyId } },
      select: { stockOnHand: true },
    });
    expect(stock.stockOnHand).toBe(7);
    const movements = await database.stockMovement.findMany({
      where: { documentId: (created.body as DocumentResponse).id },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: "SALIDA",
      quantity: -3,
      reference: (created.body as DocumentResponse).internalNumber,
    });
  });

  it("keeps idempotent retries single, returns 200, and rejects changed payloads", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const customer = await createCustomer("Idempotencia", "ACTIVE");
    const product = await createProduct("Idempotente", 8);
    const input = { customerId: customer.id, items: [productInput(product.id, 2)] };
    const key = "e2e-idempotency-01";
    const [left, right] = await Promise.all([
      httpCall(app, "post", "/documents")
        .set("Cookie", cookie)
        .set("Origin", "http://localhost:3000")
        .set("Idempotency-Key", key)
        .send(input)
        .expect((r) => expect([200, 201]).toContain(r.status)),
      httpCall(app, "post", "/documents")
        .set("Cookie", cookie)
        .set("Origin", "http://localhost:3000")
        .set("Idempotency-Key", key)
        .send(input)
        .expect((r) => expect([200, 201]).toContain(r.status)),
    ]);
    expect((left.body as DocumentResponse).id).toBe((right.body as DocumentResponse).id);
    const retries = await Promise.all([
      httpCall(app, "post", "/documents")
        .set("Cookie", cookie)
        .set("Origin", "http://localhost:3000")
        .set("Idempotency-Key", key)
        .send(input)
        .expect(200),
      httpCall(app, "post", "/documents")
        .set("Cookie", cookie)
        .set("Origin", "http://localhost:3000")
        .set("Idempotency-Key", key)
        .send(input)
        .expect(200),
    ]);
    expect(retries[0]!.body).toMatchObject({ id: (left.body as DocumentResponse).id });
    const conflict = await httpCall(app, "post", "/documents")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .set("Idempotency-Key", key)
      .send({ ...input, items: [productInput(product.id, 3)] })
      .expect(409);
    expect(conflict.body).toMatchObject({
      error: { code: "conflict", message: "La clave de idempotencia ya se usó con otros datos." },
    });
    const missing = await httpCall(app, "post", "/documents")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send(input)
      .expect(400);
    expect(missing.body).toMatchObject({
      error: { code: "validation", fieldErrors: { "Idempotency-Key": expect.any(Array) } },
    });
    expect(
      await database.document.count({
        where: { companyId: customer.companyId, customerId: customer.id },
      }),
    ).toBe(1);
    expect(
      (
        await database.product.findUniqueOrThrow({
          where: { id_companyId: { id: product.id, companyId: product.companyId } },
        })
      ).stockOnHand,
    ).toBe(6);
  });

  it("rolls back insufficient stock and rejects inactive or foreign products and customers", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const hogarCookie = await loginAs(hogarEmail, hogarPassword);
    const customer = await createCustomer("Validación", "ACTIVE");
    const inactiveCustomer = await createCustomer("Cliente inactivo", "INACTIVE");
    const product = await createProduct("Stock escaso", 1);
    const inactiveProduct = await createProduct("Producto inactivo", 4, "INACTIVE");
    const foreignProduct = await createProduct("Producto ajeno", 5, "ACTIVE", "operia-hogar");
    const input = (customerId: string, productId: string, quantity = 1) => ({
      customerId,
      items: [productInput(productId, quantity)],
    });
    const insufficient = await httpCall(app, "post", "/documents")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .set("Idempotency-Key", "e2e-stock-fail-01")
      .send(input(customer.id, product.id, 3))
      .expect(422);
    expect(insufficient.body).toMatchObject({
      error: { code: "business_rule", message: `Stock insuficiente para ${product.name}.` },
    });
    expect(await database.stockMovement.count({ where: { productId: product.id } })).toBe(0);
    expect(await database.document.count({ where: { customerId: customer.id } })).toBe(0);
    expect(
      await database.product
        .findUniqueOrThrow({
          where: { id_companyId: { id: product.id, companyId: product.companyId } },
        })
        .then((row) => row.stockOnHand),
    ).toBe(1);
    for (const [customerId, productId, key] of [
      [customer.id, inactiveProduct.id, "e2e-inactive-prod"],
      [customer.id, foreignProduct.id, "e2e-foreign-prod"],
      [inactiveCustomer.id, product.id, "e2e-inactive-cust"],
    ]) {
      const response = await httpCall(app, "post", "/documents")
        .set("Cookie", cookie)
        .set("Origin", "http://localhost:3000")
        .set("Idempotency-Key", key!)
        .send(input(customerId!, productId!))
        .expect(422);
      expect(response.body).toMatchObject({ error: { code: "business_rule" } });
    }
    const foreignCustomer = await createCustomer("Cliente de Hogar", "ACTIVE", "operia-hogar");
    await httpCall(app, "post", "/documents")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .set("Idempotency-Key", "e2e-foreign-cust")
      .send(input(foreignCustomer.id, product.id))
      .expect(422);
    const visibleDocument = await createDocument(cookie, "e2e-isolation-01", customer.id, [
      productInput(product.id),
    ]);
    await httpCall(app, "get", `/documents/${(visibleDocument.body as DocumentResponse).id}`)
      .set("Cookie", hogarCookie)
      .expect(404);
  });

  it("cancels from outgoing movements, skips manual reversals and hides cross-company ids", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const hogarCookie = await loginAs(hogarEmail, hogarPassword);
    const customer = await createCustomer("Anulación", "ACTIVE");
    const product = await createProduct("Reversión", 8);
    const created = (
      await createDocument(cookie, "e2e-cancel-0001", customer.id, [productInput(product.id, 3)])
    ).body as DocumentResponse;
    const outgoing = await database.stockMovement.findFirstOrThrow({
      where: { documentId: created.id, type: "SALIDA" },
    });
    await database.product.update({
      where: { id_companyId: { id: product.id, companyId: product.companyId } },
      data: { stockOnHand: { increment: 3 } },
    });
    await database.stockMovement.create({
      data: {
        companyId: product.companyId,
        productId: product.id,
        type: "REVERSION",
        quantity: 3,
        reference: created.internalNumber,
        note: "Reversión manual",
        reversesMovementId: outgoing.id,
        documentId: created.id,
      },
    });
    const cancelled = await httpCall(app, "post", `/documents/${created.id}/cancellation`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ reason: "Devolución manual" })
      .expect(201);
    expect(cancelled.body).toMatchObject({ status: "CANCELLED", cancelledBy: "Devolución manual" });
    expect(
      await database.product
        .findUniqueOrThrow({
          where: { id_companyId: { id: product.id, companyId: product.companyId } },
        })
        .then((row) => row.stockOnHand),
    ).toBe(8);
    await httpCall(app, "post", `/documents/${created.id}/cancellation`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ reason: "Otra vez" })
      .expect(409);
    const isolation = await httpCall(app, "get", `/documents/${created.id}`)
      .set("Cookie", hogarCookie)
      .expect(404);
    expect(isolation.body).toMatchObject({ error: { code: "not_found" } });

    const regularProduct = await createProduct("Reversión normal", 9);
    const regularDocument = (
      await createDocument(cookie, "e2e-cancel-normal-1", customer.id, [
        productInput(regularProduct.id, 4),
      ])
    ).body as DocumentResponse;
    await httpCall(app, "post", `/documents/${regularDocument.id}/cancellation`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ reason: "Reintegro normal" })
      .expect(201);
    expect(
      await database.product
        .findUniqueOrThrow({
          where: { id_companyId: { id: regularProduct.id, companyId: regularProduct.companyId } },
        })
        .then((row) => row.stockOnHand),
    ).toBe(9);
  });

  it("cancels a historical document with no outgoing movements without changing stock", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const customer = await createCustomer("Histórico", "ACTIVE");
    const product = await createProduct("Histórico", 6);
    const documentId = "pv-0001-99999990";
    const internalNumber = "0001-99999990";
    await database.document.create({
      data: {
        id: documentId,
        companyId: customer.companyId,
        customerId: customer.id,
        customerName: customer.commercialName,
        internalNumber,
        pointOfSale: "0001",
        status: "PENDING",
        totalCents: 1000,
        idempotencyKey: "e2e-historical-key",
        requestFingerprint: "historical-fingerprint",
        searchText: normalizeSearch(`${internalNumber} ${customer.commercialName}`),
        items: {
          create: [
            {
              position: 0,
              productId: product.id,
              productName: product.name,
              sku: product.sku,
              quantity: 1,
              unitPriceCents: 1000,
              discountRate: 0,
              taxRate: 0,
            },
          ],
        },
      },
    });
    await httpCall(app, "post", `/documents/${documentId}/cancellation`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ reason: "Histórico sin movimientos" })
      .expect(201);
    expect(
      await database.product
        .findUniqueOrThrow({
          where: { id_companyId: { id: product.id, companyId: product.companyId } },
        })
        .then((row) => row.stockOnHand),
    ).toBe(6);
    expect(await database.stockMovement.count({ where: { documentId } })).toBe(0);
  });

  it("paginates and filters summaries, while details order items by position", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const customer = await createCustomer("Búsqueda Ácida", "ACTIVE");
    const first = await createProduct("Primero", 10);
    const second = await createProduct("Segundo", 10);
    const old = await createDocument(cookie, "e2e-listing-0001", customer.id, [
      productInput(first.id),
      productInput(second.id),
    ]);
    const latest = await createDocument(cookie, "e2e-listing-0002", customer.id, [
      productInput(second.id),
      productInput(first.id),
    ]);
    const all = await httpCall(app, "get", `/documents?customerId=${customer.id}&page=1&pageSize=1`)
      .set("Cookie", cookie)
      .expect(200);
    expect(all.body as Page<DocumentResponse>).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 2,
      items: [{ id: (latest.body as DocumentResponse).id }],
    });
    const byStatus = await httpCall(app, "get", "/documents?status=PENDING&pageSize=100")
      .set("Cookie", cookie)
      .expect(200);
    expect((byStatus.body as Page<DocumentResponse>).items.map((row) => row.id)).toContain(
      (old.body as DocumentResponse).id,
    );
    const byAccent = await httpCall(app, "get", "/documents?search=BUSQUEDA%20ACIDA&pageSize=100")
      .set("Cookie", cookie)
      .expect(200);
    expect((byAccent.body as Page<DocumentResponse>).items.map((row) => row.id)).toContain(
      (latest.body as DocumentResponse).id,
    );
    const summary = (all.body as Page<DocumentResponse>).items[0]!;
    expect(summary).not.toHaveProperty("items");
    const detail = await httpCall(app, "get", `/documents/${(latest.body as DocumentResponse).id}`)
      .set("Cookie", cookie)
      .expect(200);
    expect((detail.body as DocumentResponse).items.map((item) => item.productId)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("allocates ten contiguous unique numbers under concurrent requests", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const customer = await createCustomer("Numeración", "ACTIVE");
    const product = await createProduct("Numeración", 100);
    // The counter never rewinds when earlier tests delete their documents, so it is the
    // only reliable baseline for the next allocated number.
    const before = await database.documentCounter.findUnique({
      where: { companyId: customer.companyId },
      select: { lastNumber: true },
    });
    const previous = before?.lastNumber ?? 0;
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        httpCall(app, "post", "/documents")
          .set("Cookie", cookie)
          .set("Origin", "http://localhost:3000")
          .set("Idempotency-Key", `e2e-sequence-${String(index).padStart(4, "0")}`)
          .send({ customerId: customer.id, items: [productInput(product.id)] })
          .expect(201),
      ),
    );
    const numbers = responses
      .map((response) => Number((response.body as DocumentResponse).internalNumber.slice(-8)))
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, index) => previous + index + 1));
  });

  async function loginAs(email: string, password: string): Promise<string> {
    return getCookie(
      await httpCall(app, "post", "/auth/login").send({ email, password }).expect(200),
    );
  }

  async function createCustomer(
    label: string,
    status: "ACTIVE" | "INACTIVE",
    companyId = "operia-central",
  ): Promise<CustomerFixture> {
    const sequence = ++fixtureSequence;
    const email = `e2e-doc-${sequence}@e2e.operia.invalid`;
    return createTestCustomer(database, {
      data: {
        companyId,
        documentNumber: calculateCuit(`30${String(sequence).padStart(8, "0")}`),
        legalName: `Comprobante ${label}`,
        commercialName: label,
        contactName: "Prueba E2E",
        email,
        phone: "11111111",
        address: "Calle E2E 1",
        city: "Buenos Aires",
        fiscalAddress: "Calle E2E 1",
        locality: "Centro",
        postalCode: "1000",
        province: "Buenos Aires",
        priceList: "General",
        status,
        vatCondition: "FINAL_CONSUMER",
      },
      select: { id: true, companyId: true, commercialName: true, email: true },
    });
  }

  async function createProduct(
    name: string,
    stock: number,
    status: "ACTIVE" | "INACTIVE" = "ACTIVE",
    companyId = "operia-central",
  ): Promise<ProductFixture> {
    const sequence = ++fixtureSequence;
    const sku = `E2E-DOC-${sequence}`;
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
        stockOnHand: stock,
        status,
        searchText: normalizeSearch(`${name} ${sku} E2E`),
        nameNormalized: normalizeSearch(name),
      },
      select: { id: true, companyId: true, name: true, sku: true },
    });
  }

  async function createDocument(
    cookie: string,
    key: string,
    customerId: string,
    items: ReturnType<typeof productInput>[],
  ) {
    return httpCall(app, "post", "/documents")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .set("Idempotency-Key", key)
      .send({ customerId, items })
      .expect(201);
  }

  async function cleanTestData(): Promise<void> {
    if (!database) return;
    const customers = await database.customer.findMany({
      where: { email: { startsWith: "e2e-doc-", endsWith: "@e2e.operia.invalid" } },
      select: { id: true },
    });
    const customerIds = customers.map(({ id }) => id);
    const documents = await database.document.findMany({
      where: { customerId: { in: customerIds } },
      select: { id: true, companyId: true },
    });
    const documentIds = documents.map(({ id }) => id);
    const products = await database.product.findMany({
      where: { sku: { startsWith: "E2E-DOC-" } },
      select: { id: true, companyId: true },
    });
    const productIds = products.map(({ id }) => id);
    if (documentIds.length) {
      await database.documentItem.deleteMany({ where: { documentId: { in: documentIds } } });
      await database.stockMovement.deleteMany({ where: { documentId: { in: documentIds } } });
      await database.document.deleteMany({ where: { id: { in: documentIds } } });
    }
    if (productIds.length) {
      await database.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await database.product.deleteMany({ where: { id: { in: productIds } } });
    }
    await database.elemSubType.deleteMany({ where: { id: { startsWith: "e2e-cat-" } } });
    if (customerIds.length)
      await database.customer.deleteMany({ where: { id: { in: customerIds } } });
  }
});
