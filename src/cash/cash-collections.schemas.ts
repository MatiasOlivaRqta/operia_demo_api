import { messageKey } from "../common/i18n/index.js";
import { z } from "zod";
import { ApiException } from "../common/errors.js";

export const cashCollectionSchema = z
  .object({
    customerId: z.string().min(1).max(100),
    amountCents: z.number().int().min(1).max(2_147_483_647),
    paymentMethod: z.enum(["CASH", "TRANSFER", "CARD"]),
    documentId: z.string().min(1).max(100).optional(),
  })
  .strict();
export type CashCollectionInput = z.infer<typeof cashCollectionSchema>;

export function validateCollectionKey(key: string | undefined): string {
  if (typeof key !== "string" || key.length < 8 || key.length > 100)
    throw new ApiException("validation", messageKey("validation.reviewInput"), 400, {
      "Idempotency-Key": ["customer.idempotency.length"],
    });
  return key;
}
