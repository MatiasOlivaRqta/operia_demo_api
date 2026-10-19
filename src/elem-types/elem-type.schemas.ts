import { z } from "zod";
import { paginationSchema } from "../common/pagination.js";

export const subTypeParamsSchema = z.object({ typeId: z.string().trim().min(1).max(50) }).strict();

export const subTypeQuerySchema = paginationSchema
  .extend({ search: z.string().trim().max(200).optional() })
  .strict();

export const subTypeSchema = z.object({ description: z.string().trim().min(1).max(100) }).strict();

export type SubTypeQuery = z.infer<typeof subTypeQuerySchema>;
export type SubTypeInput = z.infer<typeof subTypeSchema>;

export const subTypeInputOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["description"],
  properties: { description: { type: "string", minLength: 1, maxLength: 100 } },
} as const;
