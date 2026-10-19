import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiException } from "../common/errors.js";
import { messageKey } from "../common/i18n/index.js";
import type { AuthenticatedRequest } from "../common/request-context.js";
import type { Permission } from "./permissions.catalog.js";
import { REQUIRE_PERMISSION_KEY } from "./require-permission.decorator.js";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = request.sessionContext;
    if (!session) {
      throw new ApiException("unauthenticated", messageKey("auth.session.invalid"), 401);
    }
    if (required.some((permission) => session.permissions.includes(permission))) return true;

    throw new ApiException("forbidden", messageKey("error.forbidden"), 403);
  }
}
