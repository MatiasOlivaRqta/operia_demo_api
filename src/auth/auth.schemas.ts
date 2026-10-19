import { z } from "zod";

export const loginSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().min(1).max(1024),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

export const companyIdSchema = z.object({ id: z.string().min(1).max(100) }).strict();
