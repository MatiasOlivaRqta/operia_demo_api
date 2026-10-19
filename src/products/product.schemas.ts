import { messageKey } from "../common/i18n/index.js";
import { z } from "zod";
import { paginationSchema } from "../common/pagination.js";
import { ApiException } from "../common/errors.js";

export const productSchema = z
  .object({
    sku: z.string().trim().min(1).max(64),
    barcode: z.string().trim().max(64),
    name: z.string().trim().min(1).max(200),
    categoryId: z.string().trim().min(1).max(100),
    unit: z.string().trim().min(1).max(32),
    costCents: z.number().int().min(0).max(2_000_000_000),
    priceCents: z.number().int().min(1).max(2_000_000_000),
    minimumStock: z.number().int().min(0).max(1_000_000),
    status: z.enum(["active", "inactive"]),
  })
  .strict();

export const productQuerySchema = paginationSchema
  .extend({
    search: z.string().trim().max(200).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    lowStock: z.enum(["true"]).optional(),
  })
  .strict();

export const productIdSchema = z.object({ id: z.string().min(1).max(100) }).strict();
export const movementIdSchema = z
  .object({ id: z.string().min(1).max(100), movementId: z.string().min(1).max(100) })
  .strict();
export const productMovementQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(500).optional(),
  })
  .strict();
export type ProductMovementCursor = { t: string; id: string };
const productMovementCursorSchema = z
  .object({
    t: z.iso.datetime({ offset: true }).regex(/\.\d{3}Z$/),
    id: z.string().min(1).max(300),
  })
  .strict();

export function encodeProductMovementCursor(cursor: ProductMovementCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeProductMovementCursor(value: string): ProductMovementCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
    const json = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== value)
      throw new Error("Non-canonical cursor");
    const parsed: unknown = JSON.parse(json);
    const result = productMovementCursorSchema.safeParse(parsed);
    if (!result.success) throw new Error("Invalid cursor fields");
    return result.data;
  } catch {
    throw new ApiException("validation", messageKey("validation.cursor.invalid"), 400, {
      cursor: ["validation.cursor.invalid"],
    });
  }
}
export const stockMovementSchema = z
  .object({
    action: z.enum(["Ingreso", "Salida"]),
    quantity: z.number().int().min(1).max(1_000_000),
    note: z.string().trim().min(1).max(500),
  })
  .strict();
export const stockAdjustmentSchema = z
  .object({
    targetStock: z.number().int().min(0).max(100_000_000),
    note: z.string().trim().min(1).max(500),
  })
  .strict();
export const reversalSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

export type ProductInput = z.infer<typeof productSchema>;
export type ProductQuery = z.infer<typeof productQuerySchema>;
export type ProductMovementQuery = z.infer<typeof productMovementQuerySchema>;
export type StockMovementInput = z.infer<typeof stockMovementSchema>;
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;
export type ReversalInput = z.infer<typeof reversalSchema>;

export const productInputOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sku",
    "barcode",
    "name",
    "categoryId",
    "unit",
    "costCents",
    "priceCents",
    "minimumStock",
    "status",
  ],
  properties: {
    sku: { type: "string", minLength: 1, maxLength: 64 },
    barcode: { type: "string", maxLength: 64 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    categoryId: { type: "string", minLength: 1, maxLength: 100 },
    unit: { type: "string", minLength: 1, maxLength: 32 },
    costCents: { type: "integer", minimum: 0, maximum: 2_000_000_000 },
    priceCents: { type: "integer", minimum: 1, maximum: 2_000_000_000 },
    minimumStock: { type: "integer", minimum: 0, maximum: 1_000_000 },
    status: { type: "string", enum: ["active", "inactive"] },
  },
} as const;

export const stockMovementInputOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "quantity", "note"],
  properties: {
    action: { type: "string", enum: ["Ingreso", "Salida"] },
    quantity: { type: "integer", minimum: 1, maximum: 1_000_000 },
    note: { type: "string", minLength: 1, maxLength: 500 },
  },
} as const;

export const stockAdjustmentOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetStock", "note"],
  properties: {
    targetStock: { type: "integer", minimum: 0, maximum: 100_000_000 },
    note: { type: "string", minLength: 1, maxLength: 500 },
  },
} as const;

export const reversalOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: { reason: { type: "string", minLength: 1, maxLength: 500 } },
} as const;
