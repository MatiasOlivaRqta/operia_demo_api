import { describe, expect, it } from "vitest";
import { ApiException } from "../common/errors.js";
import {
  decodeProductMovementCursor,
  encodeProductMovementCursor,
  productMovementQuerySchema,
  productSchema,
} from "./product.schemas.js";

describe("product input schema", () => {
  const valid = {
    sku: "SKU-1",
    barcode: "",
    name: "Taladro",
    categoryId: "cat-1",
    unit: "unidad",
    costCents: 100,
    priceCents: 200,
    minimumStock: 0,
    status: "active",
  };

  it("requires categoryId and rejects the legacy text category", () => {
    expect(productSchema.safeParse(valid).success).toBe(true);
    const withoutCategory = { ...valid, categoryId: undefined };
    expect(productSchema.safeParse(withoutCategory).success).toBe(false);
    expect(productSchema.safeParse({ ...withoutCategory, category: "Herramientas" }).success).toBe(
      false,
    );
    expect(productSchema.safeParse({ ...valid, category: "Herramientas" }).success).toBe(false);
  });
});

describe("product movement schemas", () => {
  it("round trips a canonical movement cursor", () => {
    const cursor = { t: "2026-10-09T12:00:00.123Z", id: "movement-1" };
    expect(decodeProductMovementCursor(encodeProductMovementCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed or manipulated cursors with a cursor validation error", () => {
    const manipulated = encodeProductMovementCursor({ t: "2026-10-09T12:00:00.123Z", id: "" });
    for (const value of ["!not-base64url!", manipulated]) {
      try {
        decodeProductMovementCursor(value);
        throw new Error("Expected an invalid cursor to be rejected.");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ApiException);
        if (error instanceof ApiException) {
          expect(error.code).toBe("validation");
          expect(error.getStatus()).toBe(400);
          expect(error.fieldErrors).toMatchObject({ cursor: [expect.any(String)] });
        }
      }
    }
  });

  it("defaults the limit and strictly rejects invalid limits and legacy pagination", () => {
    expect(productMovementQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(productMovementQuerySchema.parse({ limit: "100" })).toEqual({ limit: 100 });
    for (const value of [{ limit: "0" }, { limit: "101" }, { page: "1" }, { pageSize: "20" }])
      expect(productMovementQuerySchema.safeParse(value).success).toBe(false);
  });
});
