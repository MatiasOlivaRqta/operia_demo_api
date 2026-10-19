import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "./permissions.catalog.js";
import { permissionsForRole } from "./permissions.service.js";

describe("permissionsForRole", () => {
  it("ignora permisos desconocidos", () => {
    expect(
      permissionsForRole({ name: "Personalizado", isSystem: false, permissions: ["desconocido"] }),
    ).toEqual([]);
  });

  it("devuelve todo el catálogo para ADMIN de sistema aunque no tenga permisos guardados", () => {
    expect(permissionsForRole({ name: "ADMIN", isSystem: true, permissions: [] })).toEqual(
      ALL_PERMISSIONS,
    );
  });

  it("incluye permisos nuevos del catálogo para ADMIN sin actualizar sus datos", () => {
    expect(permissionsForRole({ name: "ADMIN", isSystem: true, permissions: [] })).toContain(
      "users.manage",
    );
  });

  it("devuelve los permisos válidos de un rol común sin duplicados", () => {
    expect(
      permissionsForRole({
        name: "Facturación",
        isSystem: false,
        permissions: ["documents.write", "customers.read", "documents.write", "no.existe"],
      }),
    ).toEqual(["documents.write", "customers.read"]);
  });

  it("no concede el catálogo a un rol llamado ADMIN que no es de sistema", () => {
    expect(
      permissionsForRole({ name: "ADMIN", isSystem: false, permissions: ["customers.read"] }),
    ).toEqual(["customers.read"]);
  });
});
