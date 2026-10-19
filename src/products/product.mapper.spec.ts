import { describe, expect, it } from "vitest";
import type { Product, StockMovement } from "../generated/prisma/client.js";
import { mapMovementToDto, mapProductToDto } from "./product.mapper.js";

describe("product mappers", () => {
  it("maps stock and low stock without exposing internal fields", () => {
    const row = {
      id: "p1",
      companyId: "c1",
      sku: "SKU",
      barcode: "",
      name: "Taladro",
      categoryId: "cat1",
      category: { description: "Tools" },
      unit: "u",
      costCents: 100,
      priceCents: 200,
      minimumStock: 3,
      stockOnHand: 3,
      status: "ACTIVE",
    } as unknown as Parameters<typeof mapProductToDto>[0];
    expect(mapProductToDto(row)).toMatchObject({
      status: "active",
      stock: 3,
      lowStock: true,
      categoryId: "cat1",
      category: "Tools",
    });
    expect(mapProductToDto(row)).not.toHaveProperty("searchText");
  });

  it("maps Prisma movement enums and reversed state", () => {
    const row = {
      id: "m1",
      companyId: "c1",
      productId: "p1",
      type: "REVERSION",
      quantity: 2,
      reference: "",
      note: "test",
      documentId: null,
      reversesMovementId: "m0",
      createdAt: new Date("2026-08-25T00:00:00Z"),
      product: { name: "Taladro", sku: "SKU" },
    } as MovementWithProductFixture;
    expect(mapMovementToDto(row, new Set(["m1"]))).toMatchObject({
      type: "Reversion",
      reversed: true,
      reversesMovementId: "m0",
      date: "2026-08-24T21:00:00.000-03:00",
    });
  });
});

type MovementWithProductFixture = StockMovement & { product: Pick<Product, "name" | "sku"> };
