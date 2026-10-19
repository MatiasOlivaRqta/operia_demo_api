import { z } from "zod";

export const cashSessionIdSchema = z.object({ id: z.string().uuid() }).strict();
export const openCashSessionSchema = z
  .object({
    openingBalanceCents: z.number().int().min(0).max(2_147_483_647),
  })
  .strict();
export const closeCashSessionSchema = z
  .object({
    declaredBalanceCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    observation: z.string().trim().max(500).optional(),
  })
  .strict();

export type OpenCashSessionInput = z.infer<typeof openCashSessionSchema>;
export type CloseCashSessionInput = z.infer<typeof closeCashSessionSchema>;
