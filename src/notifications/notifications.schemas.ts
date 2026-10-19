import { z } from "zod";
import { pageSchema } from "../common/pagination.js";

export const notificationsQuerySchema = z
  .object({
    page: pageSchema,
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const notificationIdSchema = z.object({ id: z.uuid() }).strict();

export type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;
