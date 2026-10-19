import "reflect-metadata";
import { HttpStatus, type ArgumentsHost, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { ApiException } from "../common/errors.js";
import { ApiExceptionFilter } from "../common/api-exception.filter.js";
import { messageKey, t } from "../common/i18n/index.js";
import type { AuthenticatedRequest } from "../common/request-context.js";
import type { Permission } from "./permissions.catalog.js";
import { PermissionsGuard } from "./permissions.guard.js";
import { REQUIRE_PERMISSION_KEY } from "./require-permission.decorator.js";

describe("PermissionsGuard", () => {
  const handler = vi.fn();
  const controller = class TestController {};

  it("permite el acceso cuando está presente el permiso requerido", () => {
    const guard = createGuard(["customers.read"]);
    expect(
      guard.canActivate(
        createContext({
          userId: "user",
          companyId: "company",
          sessionId: "session",
          permissions: ["customers.read"],
        }),
      ),
    ).toBe(true);
  });

  it("rechaza con 403 forbidden y mensaje traducido cuando falta el permiso", () => {
    const guard = createGuard(["customers.write"]);
    let exception: ApiException | undefined;

    try {
      guard.canActivate(
        createContext({
          userId: "user",
          companyId: "company",
          sessionId: "session",
          permissions: ["customers.read"],
        }),
      );
    } catch (error) {
      if (error instanceof ApiException) exception = error;
    }

    expect(exception?.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(exception?.code).toBe("forbidden");
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    new ApiExceptionFilter().catch(exception, createHost(response, "es"));
    expect(response.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: "forbidden", message: t("es", messageKey("error.forbidden")) },
    });
  });

  it("acepta cualquiera de varios permisos requeridos", () => {
    const guard = createGuard(["customers.write", "documents.write"]);
    expect(
      guard.canActivate(
        createContext({
          userId: "user",
          companyId: "company",
          sessionId: "session",
          permissions: ["documents.write"],
        }),
      ),
    ).toBe(true);
  });

  it("deja pasar una ruta sin decorador aunque no haya sesión", () => {
    Reflect.deleteMetadata(REQUIRE_PERMISSION_KEY, handler);
    const guard = new PermissionsGuard(new Reflector());

    expect(guard.canActivate(createContext())).toBe(true);
  });

  it("responde 401 con la clave de sesión inválida si falta el contexto", () => {
    const guard = createGuard(["customers.read"]);

    try {
      guard.canActivate(createContext());
      throw new Error("Se esperaba una excepción de autenticación.");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      expect((error as ApiException).code).toBe("unauthenticated");
      expect((error as ApiException).messageKey).toBe(messageKey("auth.session.invalid"));
    }
  });

  function createGuard(permissions: Permission[]): PermissionsGuard {
    Reflect.defineMetadata(REQUIRE_PERMISSION_KEY, permissions, handler);
    return new PermissionsGuard(new Reflector());
  }

  function createContext(
    sessionContext?: AuthenticatedRequest["sessionContext"],
  ): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => ({ sessionContext }) }),
    } as unknown as ExecutionContext;
  }
});

function createHost(
  response: { status: (code: number) => unknown; json: (body: unknown) => unknown },
  language: string,
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({
        method: "GET",
        path: "/test",
        headers: { "accept-language": language },
      }),
    }),
  } as unknown as ArgumentsHost;
}
