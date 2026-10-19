import { describe, expect, it } from "vitest";
import { createUserSchema } from "./user.schemas.js";

describe("createUserSchema", () => {
  it("normaliza correo como login y conserva los límites de contraseña", () => {
    const input = createUserSchema.parse({
      email: "  User@Example.Test  ",
      name: "  Persona  ",
      password: "123456789012",
      roleId: "d2719c19-a3f4-4b88-b121-424fe3306de1",
    });
    expect(input).toMatchObject({ email: "user@example.test", name: "Persona" });
    expect(createUserSchema.safeParse({ ...input, password: "short" }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...input, password: "x".repeat(129) }).success).toBe(false);
  });
});
