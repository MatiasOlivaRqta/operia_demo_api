import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi.js";

function collectRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectRefs);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) =>
    key === "$ref" && typeof nested === "string" ? [nested] : collectRefs(nested),
  );
}

describe("OpenAPI document", () => {
  it("resolves every local schema reference", () => {
    const schemas = openApiDocument.components.schemas;
    for (const reference of collectRefs(openApiDocument)) {
      const match = /^#\/components\/schemas\/([^/]+)$/.exec(reference);
      expect(match, `Referencia no local o mal formada: ${reference}`).not.toBeNull();
      expect(Object.hasOwn(schemas, match![1]!)).toBe(true);
    }
  });

  it("documents every dashboard, product, inventory, document, cash, account, notification, and Telegram route and method", () => {
    const routes: ReadonlyArray<readonly [string, string]> = [
      ["/customers", "get"],
      ["/products", "get"],
      ["/products", "post"],
      ["/products/{id}", "get"],
      ["/products/{id}", "patch"],
      ["/products/{id}/stock-movements", "post"],
      ["/products/{id}/stock-adjustments", "post"],
      ["/products/{id}/stock-movements/{movementId}/reversal", "post"],
      ["/products/{id}/movements", "get"],
      ["/stock-movements", "get"],
      ["/inventory/summary", "get"],
      ["/dashboard/summary", "get"],
      ["/dashboard/activity", "get"],
      ["/documents", "get"],
      ["/documents", "post"],
      ["/documents/{id}", "get"],
      ["/documents/{id}/cancellation", "post"],
      ["/cash/movements", "get"],
      ["/cash/sessions/current/totals", "get"],
      ["/cash/sessions", "post"],
      ["/cash/sessions/current", "get"],
      ["/cash/sessions/{id}/close", "post"],
      ["/cash/sessions/{id}/collections", "post"],
      ["/customers/{id}/account", "get"],
      ["/customers/{id}/account/movements", "get"],
      ["/customers/{id}/account/collections/{cashMovementId}", "get"],
      ["/customers/{id}/account/applications", "post"],
      ["/documents/{id}/collections", "get"],
      ["/notifications", "get"],
      ["/notifications/unread-count", "get"],
      ["/notifications/{id}/read", "post"],
      ["/notifications/read-all", "post"],
      ["/telegram/link-token", "post"],
      ["/auth/logout-all", "post"],
    ];
    for (const [path, method] of routes) {
      expect(openApiDocument.paths[path as keyof typeof openApiDocument.paths]).toHaveProperty(
        method,
      );
    }
  });

  it("documents notification pagination bounds and Telegram availability errors", () => {
    expect(openApiDocument.paths["/notifications"].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "pageSize",
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        }),
      ]),
    );
    expect(openApiDocument.paths["/telegram/link-token"].post.responses).toHaveProperty("401");
    expect(openApiDocument.paths["/telegram/link-token"].post.responses).toHaveProperty("503");
  });

  it("requires a bounded Idempotency-Key header for cash collections", () => {
    expect(openApiDocument.paths["/cash/sessions/{id}/collections"].post.parameters).toContainEqual(
      {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 8, maxLength: 100 },
      },
    );
  });

  it("documents collection detail routes and nullable movement relation IDs", () => {
    const documentCollections = openApiDocument.paths["/documents/{id}/collections"].get;
    expect(documentCollections.responses).toHaveProperty("401");
    expect(documentCollections.responses).toHaveProperty("403");
    expect(documentCollections.responses).toHaveProperty("404");
    expect(openApiDocument.components.schemas.CustomerAccountMovement.required).toContain(
      "documentId",
    );
    expect(openApiDocument.components.schemas.CustomerAccountMovement.required).toContain(
      "cashMovementId",
    );
    expect(
      openApiDocument.components.schemas.CustomerAccountMovement.properties.documentId,
    ).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    const cashCollections =
      openApiDocument.paths["/customers/{id}/account/collections/{cashMovementId}"].get;
    expect(cashCollections.responses).toHaveProperty("401");
    expect(cashCollections.responses).toHaveProperty("403");
    expect(cashCollections.responses).toHaveProperty("404");
  });

  it("documents the paginated customer list query and response", () => {
    const operation = openApiDocument.paths["/customers"].get;
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "page", in: "query" }),
        expect.objectContaining({ name: "pageSize", in: "query" }),
        expect.objectContaining({ name: "vatCondition", in: "query" }),
      ]),
    );
    expect(operation.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/CustomerPage",
    });
    expect(openApiDocument.components.schemas.CustomerPage).toMatchObject({
      required: ["items", "page", "pageSize", "total"],
    });
  });

  it("documents cursor pagination for product movement history", () => {
    const operation = openApiDocument.paths["/products/{id}/movements"].get;
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        }),
        expect.objectContaining({ name: "cursor", in: "query" }),
      ]),
    );
    expect(operation.parameters).not.toContainEqual(
      expect.objectContaining({ name: "page", in: "query" }),
    );
    expect(operation.parameters).not.toContainEqual(
      expect.objectContaining({ name: "pageSize", in: "query" }),
    );
    expect(operation.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/ProductMovementCursorPage",
    });
    expect(openApiDocument.components.schemas.ProductMovementCursorPage).toMatchObject({
      required: ["items", "nextCursor"],
      properties: { nextCursor: { type: "string", nullable: true } },
    });
  });

  it("documents filters for the global stock movement list", () => {
    const operation = openApiDocument.paths["/stock-movements"].get;
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "productId",
          in: "query",
          schema: { type: "string", minLength: 1, maxLength: 100 },
        }),
        expect.objectContaining({
          name: "from",
          in: "query",
          schema: { type: "string", format: "date" },
        }),
        expect.objectContaining({
          name: "to",
          in: "query",
          schema: { type: "string", format: "date" },
        }),
      ]),
    );
  });

  it("documents the strict cash opening body and public openedBy identity", () => {
    const schemas = openApiDocument.components.schemas;
    expect(schemas.OpenCashSessionInput).toMatchObject({
      additionalProperties: false,
      required: ["openingBalanceCents"],
      properties: { openingBalanceCents: expect.any(Object) },
    });
    expect(schemas.OpenCashSession.required).toContain("openedBy");
    expect(schemas.OpenCashSession.properties.openedBy).toMatchObject({
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string" } },
    });
    expect(JSON.stringify(schemas)).not.toContain("operatorName");
  });

  it("matches the checked in JSON export", async () => {
    const exported = JSON.parse(
      await readFile(resolve(process.cwd(), "openapi.json"), "utf8"),
    ) as unknown;
    expect(exported).toEqual(openApiDocument);
  });
});
