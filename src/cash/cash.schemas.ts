import { z } from "zod";
import { dateSchema } from "../common/dates.js";
import { paginationSchema } from "../common/pagination.js";
import { messageKey } from "../common/i18n/index.js";

export const cashMovementQuerySchema = paginationSchema
  .extend({
    sessionId: z.string().uuid().optional(),
    paymentMethod: z.enum(["CASH", "TRANSFER", "CARD"]).optional(),
    customerId: z.string().min(1).max(100).optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if ((query.from === undefined) !== (query.to === undefined)) {
      context.addIssue({
        code: "custom",
        path: [query.from === undefined ? "from" : "to"],
        message: messageKey("validation.cash.dateRangeRequired"),
      });
      return;
    }
    if (!query.from || !query.to) return;
    if (query.from > query.to) {
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
      return;
    }
    const [fy, fm, fd] = query.from.split("-").map(Number);
    const [ty, tm, td] = query.to.split("-").map(Number);
    const days = (Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000 + 1;
    if (!query.sessionId && days > 30) {
      context.addIssue({
        code: "custom",
        path: ["from"],
        message: messageKey("validation.dateRange.max30Days"),
      });
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: messageKey("validation.dateRange.max30Days"),
      });
    }
  });

export type CashMovementQuery = z.infer<typeof cashMovementQuerySchema>;
