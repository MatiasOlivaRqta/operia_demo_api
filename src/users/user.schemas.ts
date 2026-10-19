import { z } from "zod";

export const createUserSchema = z
  .object({
    email: z.string().trim().normalize().toLowerCase().pipe(z.email()),
    name: z.string().trim().min(1).max(120),
    password: z.string().min(12).max(128),
    roleId: z.uuid(),
  })
  .strict();
export const updateUserSchema = z.object({ roleId: z.uuid() }).strict();
export const userIdSchema = z.object({ id: z.uuid() }).strict();
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
