import { z } from "zod";
import { dateSchema } from "../common/dates.js";
import { paginationSchema } from "../common/pagination.js";
import { messageKey } from "../common/i18n/index.js";

export const inventoryMovementQuerySchema = paginationSchema
  .extend({
    type: z.enum(["Ingreso", "Salida", "Ajuste", "Reversion"]).optional(),
    productId: z.string().min(1).max(100).optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.from && query.to && query.from > query.to) {
      context.addIssue({
        code: "custom",
        path: ["from"],
        message: messageKey("validation.cash.fromBeforeTo"),
      });
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: messageKey("validation.cash.toAfterFrom"),
      });
    }
  });
export type InventoryMovementQuery = z.infer<typeof inventoryMovementQuerySchema>;
