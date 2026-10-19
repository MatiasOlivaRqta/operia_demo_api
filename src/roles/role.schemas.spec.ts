import { describe, expect, it } from "vitest";
import { createRoleSchema } from "./role.schemas.js";

describe("createRoleSchema", () => {
  it("recorta el nombre y admite permisos vacíos", () => {
    expect(createRoleSchema.parse({ name: "  Caja  ", permissions: [] })).toEqual({
      name: "Caja",
      permissions: [],
    });
  });
  it("rechaza ADMIN, permisos desconocidos y duplicados", () => {
    expect(createRoleSchema.safeParse({ name: "admin", permissions: [] }).success).toBe(false);
    expect(
      createRoleSchema.safeParse({ name: "Ventas", permissions: ["unknown.write"] }).success,
    ).toBe(false);
    expect(
      createRoleSchema.safeParse({ name: "Ventas", permissions: ["cash.read", "cash.read"] })
        .success,
    ).toBe(false);
  });
});
