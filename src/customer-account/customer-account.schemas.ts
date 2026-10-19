import { messageKey } from "../common/i18n/index.js";
import { z } from "zod";
import { paginationSchema } from "../common/pagination.js";
import { ApiException } from "../common/errors.js";

export const accountCustomerParamsSchema = z.object({ id: z.string().min(1).max(100) }).strict();
export const accountCollectionParamsSchema = z
  .object({ id: z.string().min(1).max(100), cashMovementId: z.string().min(1).max(100) })
  .strict();
export const accountQuerySchema = paginationSchema;
export type AccountQuery = z.infer<typeof accountQuerySchema>;
export const accountApplicationSchema = z
  .object({
    documentId: z.string().min(1).max(100),
    amountCents: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();
export type AccountApplicationInput = z.infer<typeof accountApplicationSchema>;

export const accountMovementsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(500).optional(),
  })
  .strict();
export type AccountMovementsQuery = z.infer<typeof accountMovementsQuerySchema>;
export type AccountCollectionParams = z.infer<typeof accountCollectionParamsSchema>;

export const movementKindOrder = {
  DOCUMENT: 1,
  CREDIT_APPLIED: 2,
  COLLECTION: 3,
  CANCELLATION: 4,
} as const;
export type AccountMovementKind = keyof typeof movementKindOrder;
export const accountMovementDtoSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["DOCUMENT", "CREDIT_APPLIED", "COLLECTION", "CANCELLATION"]),
    occurredAt: z.iso.datetime({ offset: true }),
    reference: z.string(),
    documentNumber: z.string().nullable(),
    documentId: z.string().nullable(),
    cashMovementId: z.string().nullable(),
    debitCents: z.number().int(),
    creditCents: z.number().int(),
    appliedCents: z.number().int().nullable(),
    balanceCents: z.number().int(),
  })
  .strict();
export type AccountMovementDto = z.infer<typeof accountMovementDtoSchema>;
export type AccountMovementCursor = { t: string; k: number; id: string };
const cursorSchema = z
  .object({
    t: z.iso.datetime({ offset: true }),
    k: z.number().int().min(1).max(4),
    id: z.string().min(1).max(300),
  })
  .strict();

export function encodeAccountMovementCursor(cursor: AccountMovementCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeAccountMovementCursor(value: string): AccountMovementCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
    const json = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== value)
      throw new Error("Non-canonical cursor");
    const parsed: unknown = JSON.parse(json);
    const result = cursorSchema.safeParse(parsed);
    if (
      !result.success ||
      !Object.values(movementKindOrder).includes(result.data.k as 1 | 2 | 3 | 4)
    )
      throw new Error("Invalid cursor fields");
    return result.data;
  } catch {
    throw new ApiException("validation", messageKey("validation.cursor.invalid"), 400, {
      cursor: ["validation.cursor.invalid"],
    });
  }
}
