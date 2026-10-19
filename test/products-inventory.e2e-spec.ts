import "dotenv/config";
import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureHttpSecurity } from "../src/common/http-security.js";
import { DatabaseService } from "../src/database/database.service.js";
import { ensureProductCategory } from "./helpers/categories.js";

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
type ApiErrorResponse = {
  error: { code: string; message: string; fieldErrors?: Record<string, string[]> };
};
type ProductResponse = {
  id: string;
  companyId: string;
  sku: string;
  name: string;
  stock: number;
  lowStock: boolean;
  status: string;
  categoryId: string;
  category: string;
};
type MovementResponse = {
  id: string;
  quantity: number;
  type: string;
  reversed: boolean;
  date: string;
};
type Page<T> = { items: T[]; page: number; pageSize: number; total: number };
type MovementCursorPage = { items: MovementResponse[]; nextCursor: string | null };

function httpCall(
  app: INestApplication,
  method: "get" | "post" | "patch",
  path: string,
): TestRequest {
  const agent = request(app.getHttpServer());
  const call =
    method === "get" ? agent.get(path) : method === "post" ? agent.post(path) : agent.patch(path);
  return call as unknown as TestRequest;
}

function getCookie(response: TestResponse): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") throw new Error("El login no creó la cookie de sesión.");
  return value.split(";")[0]!;
}

function errorResponse(response: TestResponse, code: string): ApiErrorResponse {
  expect(response.body).toMatchObject({ error: { code, message: expect.any(String) } });
  return response.body as ApiErrorResponse;
}

function productInput(
  sku: string,
  name = "Producto e2e",
  stockMinimum = 0,
  status: "active" | "inactive" = "active",
) {
  return {
    sku,
    barcode: "",
    name,
    categoryId: "e2e-cat-operia-central",
    unit: "unidad",
    costCents: 1000,
    priceCents: 2000,
    minimumStock: stockMinimum,
    status,
  };
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

describe("Products, stock and inventory (e2e)", () => {
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
    await createTestCategories();
    resetRateLimits();
  });
  afterEach(async () => {
    await cleanTestData();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("creates, searches literally, reads, updates and rejects duplicate SKUs", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const created = await createProduct(
      cookie,
      productInput("E2E-100%_LITERAL", "Taladro Pércutor literal"),
    );
    const wildcardCandidate = await createProduct(
      cookie,
      productInput("E2E-100XXLITERAL", "Producto candidato comodín"),
    );
    expect(created.stock).toBe(0);
    const literal = await httpCall(app, "get", "/products?search=E2E-100%25_LITERAL")
      .set("Cookie", cookie)
      .expect(200);
    expect((literal.body as Page<ProductResponse>).items.map((row) => row.id)).toEqual([
      created.id,
    ]);
    expect(wildcardCandidate.id).not.toBe(created.id);
    const nonLiteral = await httpCall(app, "get", "/products?search=100XXLITERAL")
      .set("Cookie", cookie)
      .expect(200);
    expect((nonLiteral.body as Page<ProductResponse>).items.map((row) => row.id)).not.toContain(
      created.id,
    );
    const byAccent = await httpCall(app, "get", "/products?search=TALADRO%20PERCUTOR")
      .set("Cookie", cookie)
      .expect(200);
    expect((byAccent.body as Page<ProductResponse>).items.map((row) => row.id)).toContain(
      created.id,
    );
    const duplicate = await httpCall(app, "post", "/products")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send(productInput("e2e-100%_literal"))
      .expect(409);
    expect(errorResponse(duplicate, "conflict").error.fieldErrors).toHaveProperty("sku");
    const updated = await httpCall(app, "patch", `/products/${created.id}`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send(productInput("E2E-100%_LITERAL", "Actualizado", 2, "inactive"))
      .expect(200);
    expect(updated.body as ProductResponse).toMatchObject({
      name: "Actualizado",
      status: "inactive",
      stock: 0,
      lowStock: true,
    });
    const inactive = await httpCall(app, "get", "/products?status=inactive&search=Actualizado")
      .set("Cookie", cookie)
      .expect(200);
    expect((inactive.body as Page<ProductResponse>).items.map((row) => row.id)).toContain(
      created.id,
    );
    await httpCall(app, "get", `/products/${created.id}`).set("Cookie", cookie).expect(200);
  });

  it("validates the category reference, returns categoryId/category and indexes the description", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const sub = (id: string, companyId: string, description: string, elemTypeId = "PROD_CAT") =>
      database.elemSubType.create({
        data: {
          id: `e2e-cat-${id}`,
          companyId,
          elemTypeId,
          description,
          descriptionNormalized: description.toLowerCase(),
        },
      });
    await database.elemType.upsert({
      where: { id: "E2E_OTHER" },
      update: {},
      create: { id: "E2E_OTHER", description: "Otro tipo e2e" },
    });
    const electricidad = await sub("electricidad", "operia-central", "Electricidad");
    const seguridad = await sub("seguridad", "operia-central", "Seguridad");
    const foreign = await sub("foreign", "operia-hogar", "Ajena");
    const otherType = await sub("other-type", "operia-central", "Otro", "E2E_OTHER");
    const send = (method: "post" | "patch", path: string, body: object) =>
      httpCall(app, method, path)
        .set("Cookie", cookie)
        .set("Origin", "http://localhost:3000")
        .send(body);

    const created = await send("post", "/products", {
      ...productInput("E2E-CAT-1", "Producto con categoría"),
      categoryId: electricidad.id,
    }).expect(201);
    expect(created.body as ProductResponse).toMatchObject({
      categoryId: electricidad.id,
      category: "Electricidad",
    });
    const id = (created.body as ProductResponse).id;
    expect(
      (
        (await httpCall(app, "get", `/products/${id}`).set("Cookie", cookie).expect(200))
          .body as ProductResponse
      ).category,
    ).toBe("Electricidad");
    const found = async (term: string) =>
      (
        (await httpCall(app, "get", `/products?search=${term}`).set("Cookie", cookie).expect(200))
          .body as Page<ProductResponse>
      ).items.map((row) => row.id);
    expect(await found("electri")).toContain(id);

    const moved = await send("patch", `/products/${id}`, {
      ...productInput("E2E-CAT-1", "Producto con categoría"),
      categoryId: seguridad.id,
    }).expect(200);
    expect(moved.body as ProductResponse).toMatchObject({ category: "Seguridad" });
    expect(await found("segur")).toContain(id);
    expect(await found("electri")).not.toContain(id);

    for (const categoryId of [foreign.id, otherType.id, "no-existe"]) {
      const response = await send("post", "/products", {
        ...productInput("E2E-CAT-BAD", "Categoría inválida"),
        categoryId,
      }).expect(400);
      expect(errorResponse(response, "validation").error.fieldErrors).toHaveProperty("categoryId");
    }
    expect(await database.product.count({ where: { sku: "E2E-CAT-BAD" } })).toBe(0);

    const withoutCategory = {
      ...productInput("E2E-CAT-2", "Sin categoría"),
      categoryId: undefined,
    };
    const missing = await send("post", "/products", withoutCategory).expect(400);
    expect(errorResponse(missing, "validation").error.fieldErrors).toHaveProperty("categoryId");
    await send("post", "/products", { ...withoutCategory, category: "Texto libre" }).expect(400);
    await send("post", "/products", {
      ...productInput("E2E-CAT-3", "Ambos"),
      category: "Texto",
    }).expect(400);
    expect(
      await database.product.count({ where: { sku: { in: ["E2E-CAT-2", "E2E-CAT-3"] } } }),
    ).toBe(0);
  });

  it("paginates stably, filters low stock, enforces page bounds and isolates companies", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const a = await createProduct(cookie, productInput("E2E-ORDER-A", "E2E Orden A", 1));
    const b = await createProduct(cookie, productInput("E2E-ORDER-B", "E2E Orden B", 0));
    const first = await httpCall(app, "get", "/products?search=E2E%20Orden&page=1&pageSize=1")
      .set("Cookie", cookie)
      .expect(200);
    expect(first.body).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    const firstItem = (first.body as Page<ProductResponse>).items[0]!;
    const second = await httpCall(app, "get", "/products?search=E2E%20Orden&page=2&pageSize=1")
      .set("Cookie", cookie)
      .expect(200);
    expect((second.body as Page<ProductResponse>).items[0]!.id).not.toBe(firstItem.id);
    const low = await httpCall(app, "get", "/products?search=E2E%20Orden&lowStock=true")
      .set("Cookie", cookie)
      .expect(200);
    expect((low.body as Page<ProductResponse>).items.map((row) => row.id)).toEqual([a.id, b.id]);
    const badPage = await httpCall(app, "get", "/products?pageSize=101")
      .set("Cookie", cookie)
      .expect(400);
    errorResponse(badPage, "validation");
    const hogarCookie = await loginAs(hogarEmail, hogarPassword);
    const otherCompany = await createProduct(hogarCookie, {
      ...productInput("E2E-ORDER-A", "Producto otra empresa"),
      categoryId: "e2e-cat-operia-hogar",
    });
    expect(otherCompany.companyId).toBe("operia-hogar");
    await httpCall(app, "get", `/products/${a.id}`).set("Cookie", hogarCookie).expect(404);
  });

  it("records stock movements, adjustments, reversals and paged reversal flags", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const product = await createProduct(cookie, productInput("E2E-STOCK-WORKFLOW", "Flujo stock"));
    const incoming = await httpCall(app, "post", `/products/${product.id}/stock-movements`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ action: "Ingreso", quantity: 8, note: "Carga" })
      .expect(201);
    const inMovement = incoming.body as MovementResponse;
    expect(inMovement).toMatchObject({ quantity: 8, type: "Ingreso" });
    const outgoing = await httpCall(app, "post", `/products/${product.id}/stock-movements`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ action: "Salida", quantity: 3, note: "Venta" })
      .expect(201);
    const outMovement = outgoing.body as MovementResponse;
    expect(outMovement.quantity).toBe(-3);
    const insufficient = await httpCall(app, "post", `/products/${product.id}/stock-movements`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ action: "Salida", quantity: 99, note: "Exceso" })
      .expect(422);
    errorResponse(insufficient, "business_rule");
    const adjustment = await httpCall(app, "post", `/products/${product.id}/stock-adjustments`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ targetStock: 10, note: "Conteo" })
      .expect(201);
    expect((adjustment.body as MovementResponse).quantity).toBe(5);
    const same = await httpCall(app, "post", `/products/${product.id}/stock-adjustments`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ targetStock: 10, note: "Sin cambio" })
      .expect(400);
    errorResponse(same, "validation");
    const reversed = await httpCall(
      app,
      "post",
      `/products/${product.id}/stock-movements/${inMovement.id}/reversal`,
    )
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ reason: "Corrección" })
      .expect(201);
    expect((reversed.body as MovementResponse).quantity).toBe(-8);
    await httpCall(app, "post", `/products/${product.id}/stock-movements/${inMovement.id}/reversal`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ reason: "Duplicada" })
      .expect(409);
    const reversalId = (reversed.body as MovementResponse).id;
    await httpCall(app, "post", `/products/${product.id}/stock-movements/${reversalId}/reversal`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ reason: "No permitida" })
      .expect(422);
    const history = await httpCall(app, "get", `/products/${product.id}/movements?limit=100`)
      .set("Cookie", cookie)
      .expect(200);
    expect((history.body as MovementCursorPage).items).toHaveLength(4);
    expect(history.body).not.toHaveProperty("total");
    expect(
      (history.body as MovementCursorPage).items.some(
        (row) => row.id === inMovement.id && row.reversed,
      ),
    ).toBe(true);
    const drainedProduct = await createProduct(
      cookie,
      productInput("E2E-STOCK-REVERSAL-LOW", "Reversión sin stock"),
    );
    const shortIncoming = await httpCall(
      app,
      "post",
      `/products/${drainedProduct.id}/stock-movements`,
    )
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ action: "Ingreso", quantity: 2, note: "Carga" })
      .expect(201);
    await httpCall(app, "post", `/products/${drainedProduct.id}/stock-movements`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ action: "Salida", quantity: 2, note: "Consumo" })
      .expect(201);
    const negativeReversal = await httpCall(
      app,
      "post",
      `/products/${drainedProduct.id}/stock-movements/${(shortIncoming.body as MovementResponse).id}/reversal`,
    )
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ reason: "No puede quedar negativo" })
      .expect(422);
    errorResponse(negativeReversal, "business_rule");
  });

  it("paginates product movements by cursor across equal timestamps and concurrent inserts", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const product = await createProduct(cookie, productInput("E2E-MOVEMENT-CURSOR", "Cursor"));
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    const originalIds = Array.from(
      { length: 120 },
      (_, index) => `cursor-movement-${String(index).padStart(3, "0")}`,
    );
    await database.stockMovement.createMany({
      data: originalIds.map((id) => ({
        id,
        companyId: product.companyId,
        productId: product.id,
        type: "AJUSTE",
        quantity: 1,
        reference: "",
        note: "Cursor test",
        createdAt: timestamp,
      })),
    });

    const first = await httpCall(app, "get", `/products/${product.id}/movements?limit=50`)
      .set("Cookie", cookie)
      .expect(200);
    const firstPage = first.body as MovementCursorPage;
    expect(firstPage.items.map((movement) => movement.id)).toEqual(
      originalIds.slice().sort().reverse().slice(0, 50),
    );
    expect(first.body).not.toHaveProperty("total");
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const insertedId = "cursor-movement-inserted";
    await database.stockMovement.create({
      data: {
        id: insertedId,
        companyId: product.companyId,
        productId: product.id,
        type: "AJUSTE",
        quantity: 1,
        reference: "",
        note: "Inserted during pagination",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
    });

    const received = [...firstPage.items.map((movement) => movement.id)];
    let cursor = firstPage.nextCursor;
    while (cursor) {
      const response = await httpCall(
        app,
        "get",
        `/products/${product.id}/movements?limit=50&cursor=${encodeURIComponent(cursor)}`,
      )
        .set("Cookie", cookie)
        .expect(200);
      const page = response.body as MovementCursorPage;
      expect(response.body).not.toHaveProperty("total");
      received.push(...page.items.map((movement) => movement.id));
      cursor = page.nextCursor;
    }
    expect(received).toHaveLength(120);
    expect(new Set(received).size).toBe(120);
    expect(received).toEqual(originalIds.slice().sort().reverse());
    expect(received).not.toContain(insertedId);

    for (const path of [
      `/products/${product.id}/movements?cursor=not-a-valid-cursor`,
      `/products/${product.id}/movements?limit=0`,
      `/products/${product.id}/movements?page=1`,
      `/products/${product.id}/movements?pageSize=50`,
    ]) {
      const invalid = await httpCall(app, "get", path).set("Cookie", cookie).expect(400);
      errorResponse(invalid, "validation");
    }

    const hogarCookie = await loginAs(hogarEmail, hogarPassword);
    await httpCall(app, "get", `/products/${product.id}/movements?limit=10`)
      .set("Cookie", hogarCookie)
      .expect(404);
  });

  it("allows exactly ten of twenty-five concurrent one-unit withdrawals", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const product = await createProduct(
      cookie,
      productInput("E2E-STOCK-RACE", "Stock concurrente"),
    );
    await httpCall(app, "post", `/products/${product.id}/stock-adjustments`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ targetStock: 10, note: "Inicial" })
      .expect(201);
    const responses = await Promise.all(
      Array.from({ length: 25 }, () =>
        httpCall(app, "post", `/products/${product.id}/stock-movements`)
          .set("Cookie", cookie)
          .set("Origin", "http://localhost:3000")
          .send({ action: "Salida", quantity: 1, note: "Concurrente" })
          .expect((response) => expect([201, 422]).toContain(response.status)),
      ),
    );
    expect(
      responses.filter((response) => response.body && !("error" in (response.body as object))),
    ).toHaveLength(10);
    const current = await httpCall(app, "get", `/products/${product.id}`)
      .set("Cookie", cookie)
      .expect(200);
    expect((current.body as ProductResponse).stock).toBe(0);
    const history = await httpCall(app, "get", `/products/${product.id}/movements?limit=100`)
      .set("Cookie", cookie)
      .expect(200);
    const movements = (history.body as MovementCursorPage).items;
    expect(movements.reduce((sum, movement) => sum + movement.quantity, 0)).toBe(0);
    expect(movements.filter((movement) => movement.type === "Salida")).toHaveLength(10);
  });

  it("returns aggregate inventory and a globally paged, filtered movement list", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const product = await createProduct(cookie, productInput("E2E-INVENTORY", "Inventario"));
    await httpCall(app, "post", `/products/${product.id}/stock-adjustments`)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send({ targetStock: 4, note: "Inicial" })
      .expect(201);
    const summary = await httpCall(app, "get", "/inventory/summary")
      .set("Cookie", cookie)
      .expect(200);
    expect(summary.body).toMatchObject({
      activeProducts: expect.any(Number),
      totalUnits: expect.any(Number),
      inventoryValueCents: expect.any(Number),
    });
    expect((summary.body as { totalUnits: number }).totalUnits).toBeGreaterThanOrEqual(4);
    const movements = await httpCall(app, "get", "/stock-movements?type=Ajuste&pageSize=10")
      .set("Cookie", cookie)
      .expect(200);
    expect((movements.body as Page<MovementResponse>).items.some((row) => row.quantity === 4)).toBe(
      true,
    );
  });

  it("serializes stock movement dates in Argentine time for both inventory endpoints", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const product = await createProduct(
      cookie,
      productInput("E2E-ARGENTINA-MOVEMENT-DATE", "Fecha argentina"),
    );
    const movementId = "e2e-argentina-movement-date";
    await database.stockMovement.create({
      data: {
        id: movementId,
        companyId: product.companyId,
        productId: product.id,
        type: "AJUSTE",
        quantity: 1,
        reference: "",
        note: "Fecha argentina",
        createdAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    });

    const argentinaDay = await httpCall(
      app,
      "get",
      `/stock-movements?productId=${product.id}&from=2026-08-24&to=2026-08-24`,
    )
      .set("Cookie", cookie)
      .expect(200);
    expect(argentinaDay.body).toMatchObject({ total: 1 });
    expect((argentinaDay.body as Page<MovementResponse>).items).toMatchObject([
      { id: movementId, date: "2026-08-24T21:00:00.000-03:00" },
    ]);

    const utcDay = await httpCall(
      app,
      "get",
      `/stock-movements?productId=${product.id}&from=2026-08-25&to=2026-08-25`,
    )
      .set("Cookie", cookie)
      .expect(200);
    expect(utcDay.body).toMatchObject({ items: [], total: 0 });

    const history = await httpCall(app, "get", `/products/${product.id}/movements`)
      .set("Cookie", cookie)
      .expect(200);
    expect((history.body as MovementCursorPage).items).toMatchObject([
      { id: movementId, date: "2026-08-24T21:00:00.000-03:00" },
    ]);
  });

  it("filters global stock movements by product, type and Argentine calendar dates", async () => {
    const cookie = await loginAs(demoEmail, demoPassword);
    const product = await createProduct(cookie, productInput("E2E-LAST-MOVEMENTS-A", "Filtro A"));
    const secondProduct = await createProduct(
      cookie,
      productInput("E2E-LAST-MOVEMENTS-B", "Filtro B"),
    );
    const hogarCookie = await loginAs(hogarEmail, hogarPassword);
    const otherCompanyProduct = await createProduct(hogarCookie, {
      ...productInput("E2E-LAST-MOVEMENTS-OTHER", "Filtro otra empresa"),
      categoryId: "e2e-cat-operia-hogar",
    });
    const movements = [
      {
        id: "e2e-last-filter-in-argentina-09",
        productId: product.id,
        type: "INGRESO",
        createdAt: "2026-10-10T01:30:00.000Z",
      },
      {
        id: "e2e-last-filter-out-argentina-10",
        productId: product.id,
        type: "SALIDA",
        createdAt: "2026-10-10T04:00:00.000Z",
      },
      {
        id: "e2e-last-filter-adjustment-12",
        productId: product.id,
        type: "AJUSTE",
        createdAt: "2026-10-12T12:00:00.000Z",
      },
      {
        id: "e2e-last-filter-other-product",
        productId: secondProduct.id,
        type: "INGRESO",
        createdAt: "2026-10-09T12:00:00.000Z",
      },
    ] as const;
    await database.stockMovement.createMany({
      data: movements.map(({ id, productId, type, createdAt }) => ({
        id,
        companyId: product.companyId,
        productId,
        type,
        quantity: 1,
        reference: "",
        note: "Global movement filters",
        createdAt: new Date(createdAt),
      })),
    });

    const requestMovements = async (query: string) =>
      httpCall(app, "get", `/stock-movements${query}`).set("Cookie", cookie).expect(200);
    const byProduct = await requestMovements(`?productId=${product.id}&pageSize=1`);
    expect(byProduct.body).toMatchObject({ pageSize: 1, total: 3 });
    expect((byProduct.body as Page<MovementResponse>).items[0]!.id).toBe(movements[2].id);

    const byType = await requestMovements(`?productId=${product.id}&type=Salida`);
    expect(byType.body).toMatchObject({ total: 1 });
    expect((byType.body as Page<MovementResponse>).items.map((item) => item.id)).toEqual([
      movements[1].id,
    ]);

    const combined = await requestMovements(
      `?productId=${product.id}&type=Ingreso&from=2026-10-09&to=2026-10-09`,
    );
    expect(combined.body).toMatchObject({ total: 1 });
    expect((combined.body as Page<MovementResponse>).items.map((item) => item.id)).toEqual([
      movements[0].id,
    ]);

    const argentinaDay = await requestMovements(
      `?productId=${product.id}&from=2026-10-09&to=2026-10-09`,
    );
    expect((argentinaDay.body as Page<MovementResponse>).items.map((item) => item.id)).toEqual([
      movements[0].id,
    ]);
    const octoberTen = await requestMovements(
      `?productId=${product.id}&from=2026-10-10&to=2026-10-10`,
    );
    expect((octoberTen.body as Page<MovementResponse>).items.map((item) => item.id)).toEqual([
      movements[1].id,
    ]);

    const fromOnly = await requestMovements(`?productId=${product.id}&from=2026-10-10`);
    expect((fromOnly.body as Page<MovementResponse>).items.map((item) => item.id)).toEqual([
      movements[2].id,
      movements[1].id,
    ]);
    const toOnly = await requestMovements(`?productId=${product.id}&to=2026-10-09`);
    expect((toOnly.body as Page<MovementResponse>).items.map((item) => item.id)).toEqual([
      movements[0].id,
    ]);

    for (const productId of [otherCompanyProduct.id, "missing-e2e-product-id"]) {
      const empty = await requestMovements(`?productId=${productId}`);
      expect(empty.body).toMatchObject({ items: [], total: 0 });
    }

    const invalidDate = await httpCall(app, "get", "/stock-movements?from=2026-02-31")
      .set("Cookie", cookie)
      .expect(400);
    expect(errorResponse(invalidDate, "validation").error.fieldErrors).toHaveProperty("from");
    const inverted = await httpCall(app, "get", "/stock-movements?from=2026-10-10&to=2026-10-09")
      .set("Cookie", cookie)
      .expect(400);
    expect(errorResponse(inverted, "validation").error.fieldErrors).toMatchObject({
      from: expect.any(Array),
      to: expect.any(Array),
    });
    const unknown = await httpCall(app, "get", "/stock-movements?unexpected=true")
      .set("Cookie", cookie)
      .expect(400);
    errorResponse(unknown, "validation");
  });

  async function loginAs(email: string, password: string): Promise<string> {
    return getCookie(
      await httpCall(app, "post", "/auth/login").send({ email, password }).expect(200),
    );
  }

  async function createProduct(
    cookie: string,
    input: ReturnType<typeof productInput>,
  ): Promise<ProductResponse> {
    const response = await httpCall(app, "post", "/products")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000")
      .send(input)
      .expect(201);
    return response.body as ProductResponse;
  }

  async function cleanTestData(): Promise<void> {
    if (!database) return;
    await database.stockMovement.deleteMany({
      where: { product: { sku: { startsWith: "E2E-" } } },
    });
    await database.product.deleteMany({ where: { sku: { startsWith: "E2E-" } } });
    await database.elemSubType.deleteMany({ where: { id: { startsWith: "e2e-cat-" } } });
    await database.elemType.deleteMany({ where: { id: "E2E_OTHER" } });
  }

  async function createTestCategories(): Promise<void> {
    for (const companyId of ["operia-central", "operia-hogar"])
      await ensureProductCategory(database, companyId, "Pruebas");
  }
});
