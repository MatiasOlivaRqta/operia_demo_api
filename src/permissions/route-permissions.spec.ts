import "reflect-metadata";
import { type DynamicModule, type ForwardReference, type Type } from "@nestjs/common";
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { AppModule } from "../app.module.js";
import { IS_PUBLIC_KEY } from "../common/public.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "./require-permission.decorator.js";

type ControllerType = Type<unknown>;
type ModuleReference = ControllerType | DynamicModule | ForwardReference | Promise<DynamicModule>;

interface RegisteredRoute {
  method: string;
  path: string;
  controller: ControllerType;
  handler: (...args: never[]) => unknown;
}

// Se mantiene explícita y acotada a endpoints sin permisos de negocio según design.md.
// Cada método y ruta se valida abajo para que los cambios del API requieran revisar esta excepción.
const OPEN_ROUTES = [
  "POST /auth/login",
  "POST /auth/logout",
  "POST /auth/logout-all",
  "GET /auth/me",
  "GET /companies",
  "PUT /session/company/:id",
  "GET /geo/provinces",
  "GET /geo/provinces/:provinceId/localities",
  "GET /health",
  "GET /docs",
  "GET /docs-json",
] as const;

// Estos módulos representan operaciones de negocio y nunca deben quedar exceptuados.
const BUSINESS_ROUTE_PREFIXES = [
  "/customers",
  "/products",
  "/inventory",
  "/documents",
  "/cash",
  "/customer-account",
  "/dashboard",
];

const reflector = new Reflector();

describe("permisos declarados en todas las rutas", () => {
  const routes = collectRoutes(AppModule);

  it("requiere @RequirePermission en cada ruta no pública que no esté abierta explícitamente", () => {
    const openRoutes = new Set<string>(OPEN_ROUTES);
    const missingPermission = routes
      .filter((route) => {
        const targets = [route.handler, route.controller];
        const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true;
        const explicitPermission = reflector.getAllAndOverride<unknown>(
          REQUIRE_PERMISSION_KEY,
          targets,
        );
        const hasPermission = Array.isArray(explicitPermission) && explicitPermission.length > 0;
        return !isPublic && !openRoutes.has(routeKey(route)) && !hasPermission;
      })
      .map(routeKey)
      .sort();

    expect(
      missingPermission,
      `Rutas sin @RequirePermission:\n${missingPermission.join("\n")}`,
    ).toEqual([]);
  });

  it("confirma que cada excepción abierta existe y no incluye rutas de negocio", () => {
    const registeredRoutes = new Set(routes.map(routeKey));
    const staleOpenRoutes = OPEN_ROUTES.filter((route) => !registeredRoutes.has(route));
    const businessOpenRoutes = OPEN_ROUTES.filter((route) => {
      const path = route.slice(route.indexOf(" ") + 1);
      return BUSINESS_ROUTE_PREFIXES.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
    });

    expect(
      staleOpenRoutes,
      `Excepciones abiertas que no existen:\n${staleOpenRoutes.join("\n")}`,
    ).toEqual([]);
    expect(
      businessOpenRoutes,
      `Rutas de negocio incluidas en excepciones abiertas:\n${businessOpenRoutes.join("\n")}`,
    ).toEqual([]);
  });
});

function collectRoutes(rootModule: ControllerType): RegisteredRoute[] {
  const visitedModules = new Set<ControllerType>();
  const controllers = new Set<ControllerType>();

  function visit(reference: ModuleReference): void {
    if (reference instanceof Promise) return;
    if (isForwardReference(reference)) {
      visit(reference.forwardRef());
      return;
    }

    const dynamicModule = isDynamicModule(reference) ? reference : undefined;
    const moduleType = dynamicModule?.module ?? (reference as ControllerType);
    if (visitedModules.has(moduleType)) return;
    visitedModules.add(moduleType);

    const ownControllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleType) as
      ControllerType[] | undefined;
    for (const controller of [...(ownControllers ?? []), ...(dynamicModule?.controllers ?? [])]) {
      controllers.add(controller);
    }

    const ownImports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleType) as
      ModuleReference[] | undefined;
    for (const importedModule of [...(ownImports ?? []), ...(dynamicModule?.imports ?? [])]) {
      visit(importedModule);
    }
  }

  visit(rootModule);

  return [...controllers].flatMap((controller) => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as
      string | string[] | undefined;
    const prototype = controller.prototype as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== "constructor",
    );

    return methodNames.flatMap((methodName) => {
      const handler = prototype[methodName];
      if (typeof handler !== "function") return [];

      const handlerPath = Reflect.getMetadata(PATH_METADATA, handler) as
        string | string[] | undefined;
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (handlerPath === undefined || requestMethod === undefined) return [];

      return combinePaths(toPaths(controllerPath), toPaths(handlerPath)).map((path) => ({
        method: RequestMethod[requestMethod],
        path,
        controller,
        handler: handler as RegisteredRoute["handler"],
      }));
    });
  });
}

function isDynamicModule(reference: ModuleReference): reference is DynamicModule {
  return typeof reference === "object" && reference !== null && "module" in reference;
}

function isForwardReference(reference: ModuleReference): reference is ForwardReference {
  return (
    typeof reference === "object" &&
    reference !== null &&
    "forwardRef" in reference &&
    typeof reference.forwardRef === "function"
  );
}

function toPaths(path: string | string[] | undefined): string[] {
  if (path === undefined || path === "") return [""];
  return Array.isArray(path) ? path : [path];
}

function combinePaths(prefixes: string[], paths: string[]): string[] {
  return prefixes.flatMap((prefix) => paths.map((path) => normalizePath(`${prefix}/${path}`)));
}

function normalizePath(path: string): string {
  const normalized = `/${path}`.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized || "/";
}

function routeKey(route: Pick<RegisteredRoute, "method" | "path">): string {
  return `${route.method} ${route.path}`;
}
