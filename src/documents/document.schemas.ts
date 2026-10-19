import { z } from "zod";
import { paginationSchema } from "../common/pagination.js";

export const documentQuerySchema = paginationSchema
  .extend({
    search: z.string().trim().max(200).optional(),
    status: z.enum(["PENDING", "PARTIAL", "COMPLETED", "CANCELLED"]).optional(),
    customerId: z.string().min(1).max(100).optional(),
  })
  .strict();

export const documentIdSchema = z.object({ id: z.string().min(1).max(100) }).strict();
export const documentCollectionsParamsSchema = z
  .object({ id: z.string().min(1).max(100) })
  .strict();
export const documentItemSchema = z
  .object({
    productId: z.string().min(1).max(100),
    quantity: z.number().int().min(1),
    unitPriceCents: z.number().int().min(0),
    discountRate: z.number().min(0).max(100),
    taxRate: z.number().min(0).max(100),
  })
  .strict();
export const createDocumentSchema = z
  .object({
    customerId: z.string().min(1).max(100),
    items: z.array(documentItemSchema).min(1).max(100),
  })
  .strict();
export const cancellationSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

export type DocumentQuery = z.infer<typeof documentQuerySchema>;
export type DocumentCollectionsParams = z.infer<typeof documentCollectionsParamsSchema>;
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type CancellationInput = z.infer<typeof cancellationSchema>;

export const createDocumentOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["customerId", "items"],
  properties: {
    customerId: { type: "string", minLength: 1, maxLength: 100 },
    items: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "quantity", "unitPriceCents", "discountRate", "taxRate"],
        properties: {
          productId: { type: "string", minLength: 1, maxLength: 100 },
          quantity: { type: "integer", minimum: 1 },
          unitPriceCents: { type: "integer", minimum: 0 },
          discountRate: { type: "number", minimum: 0, maximum: 100 },
          taxRate: { type: "number", minimum: 0, maximum: 100 },
        },
      },
    },
  },
} as const;

export const cancellationOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: { reason: { type: "string", minLength: 1, maxLength: 500 } },
} as const;
