import type { Product, StockMovement } from "../generated/prisma/client.js";
import type { StockMovementType } from "../generated/prisma/enums.js";
import { toArgentinaIso } from "../common/argentina-time.js";
import type { ProductInput } from "./product.schemas.js";

export type ProductDto = {
  id: string;
  companyId: string;
  sku: string;
  barcode: string;
  name: string;
  categoryId: string;
  category: string;
  unit: string;
  costCents: number;
  priceCents: number;
  minimumStock: number;
  status: "active" | "inactive";
  stock: number;
  lowStock: boolean;
};

export type MovementWithProduct = StockMovement & { product: Pick<Product, "name" | "sku"> };
export type StockMovementDto = {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  date: string;
  type: "Ingreso" | "Salida" | "Ajuste" | "Reversion";
  quantity: number;
  reference: string;
  note: string;
  documentId?: string;
  reversesMovementId?: string;
  reversed: boolean;
};

export function mapProductToDto(
  row: Pick<
    Product,
    | "id"
    | "companyId"
    | "sku"
    | "barcode"
    | "name"
    | "categoryId"
    | "unit"
    | "costCents"
    | "priceCents"
    | "minimumStock"
    | "stockOnHand"
    | "status"
  > & { category: { description: string } },
): ProductDto {
  return {
    id: row.id,
    companyId: row.companyId,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    categoryId: row.categoryId,
    category: row.category.description,
    unit: row.unit,
    costCents: row.costCents,
    priceCents: row.priceCents,
    minimumStock: row.minimumStock,
    status: row.status === "ACTIVE" ? "active" : "inactive",
    stock: row.stockOnHand,
    lowStock: row.stockOnHand <= row.minimumStock,
  };
}

export function mapProductInput(input: ProductInput) {
  return {
    ...input,
    status: input.status === "active" ? ("ACTIVE" as const) : ("INACTIVE" as const),
  };
}

const movementTypes = {
  INGRESO: "Ingreso",
  SALIDA: "Salida",
  AJUSTE: "Ajuste",
  REVERSION: "Reversion",
} satisfies Record<StockMovementType, StockMovementDto["type"]>;

export function mapMovementToDto(
  row: MovementWithProduct,
  reversedIds: ReadonlySet<string>,
): StockMovementDto {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.product.name,
    sku: row.product.sku,
    date: toArgentinaIso(row.createdAt),
    type: movementTypes[row.type],
    quantity: row.quantity,
    reference: row.reference,
    note: row.note,
    ...(row.documentId ? { documentId: row.documentId } : {}),
    ...(row.reversesMovementId ? { reversesMovementId: row.reversesMovementId } : {}),
    reversed: reversedIds.has(row.id),
  };
}
