import { z } from "zod";

const telegramChatSchema = z.object({ id: z.number().int(), type: z.string() }).passthrough();
const telegramUserSchema = z
  .object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

export const telegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    chat: telegramChatSchema,
    from: telegramUserSchema.optional(),
    text: z.string().optional(),
  })
  .passthrough();

export const telegramUpdateSchema = z
  .object({ update_id: z.number().int(), message: telegramMessageSchema.optional() })
  .passthrough();

export const telegramGetUpdatesResponseSchema = z
  .object({
    ok: z.literal(true),
    result: z.array(z.object({ update_id: z.number().int() }).passthrough()),
  })
  .passthrough();

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
