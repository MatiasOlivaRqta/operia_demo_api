import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import type { HttpRequest } from "./http.js";
import { resolveLocale, type Locale } from "./i18n/index.js";
import type { Permission } from "../permissions/permissions.catalog.js";

const requestLocale = new AsyncLocalStorage<Locale>();

// Express middleware scopes the locale across guards, services, pipes and filters without changing
// the public `new ZodValidationPipe(schema)` construction used by controllers.
export function runWithRequestLocale(request: HttpRequest, next: () => void): void {
  requestLocale.run(resolveLocale(request), next);
}

export function currentRequestLocale(): Locale {
  return requestLocale.getStore() ?? "es";
}

export type SessionContext = {
  userId: string;
  companyId: string;
  sessionId: string;
  permissions: Permission[];
};

export type AuthenticatedRequest = HttpRequest & { sessionContext?: SessionContext };

export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.sessionContext) throw new Error("Authenticated session context is unavailable");
    return request.sessionContext;
  },
);
