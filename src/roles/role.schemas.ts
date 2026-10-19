import { z } from "zod";
import { messageKey } from "../common/i18n/index.js";
import { isPermission } from "../permissions/permissions.catalog.js";

const permissionsSchema = z
  .array(z.string())
  .refine((items) => new Set(items).size === items.length, {
    message: messageKey("validation.invalidValue"),
  })
  .refine((items) => items.every(isPermission), {
    message: messageKey("validation.invalidValue"),
  });

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((value) => value.toUpperCase() !== "ADMIN", {
    message: messageKey("validation.invalidValue"),
  });

export const createRoleSchema = z
  .object({ name: nameSchema, permissions: permissionsSchema })
  .strict();
export const updateRoleSchema = z
  .object({ name: nameSchema.optional(), permissions: permissionsSchema.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: messageKey("validation.invalidValue"),
  });
export const roleIdSchema = z.object({ id: z.uuid() }).strict();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
