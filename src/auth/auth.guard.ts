import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { readCookie } from "../common/cookie.js";
import { IS_PUBLIC_KEY } from "../common/public.decorator.js";
import type { AuthenticatedRequest } from "../common/request-context.js";
import { AuthService } from "./auth.service.js";
import { API_RATE_LIMIT_SERVICE, ApiRateLimitService } from "../common/api-rate-limit.js";
import { ApiException } from "../common/errors.js";
import type { HttpResponse } from "../common/http.js";
import { clearSessionCookie } from "./session-cookie.js";

function hasSessionCookie(request: AuthenticatedRequest): boolean {
  return (
    request.headers.cookie
      ?.split(";")
      .some((segment) => segment.split("=", 1)[0].trim() === AuthService.cookieName()) ?? false
  );
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    @Inject(API_RATE_LIMIT_SERVICE) private readonly rateLimit: ApiRateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<HttpResponse>();
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    if (isPublic) {
      this.rateLimit.assertAllowed(this.rateLimit.consumeAnonymous(ip), response);
      return true;
    }
    try {
      request.sessionContext = await this.auth.authenticate(
        readCookie(request, AuthService.cookieName()),
      );
    } catch (error) {
      if (error instanceof ApiException && error.getStatus() === 401) {
        if (hasSessionCookie(request)) clearSessionCookie(response);
        this.rateLimit.assertAllowed(this.rateLimit.consumeAnonymous(ip), response);
      }
      throw error;
    }
    this.rateLimit.assertAllowed(
      this.rateLimit.consumeSession(request.sessionContext.sessionId),
      response,
    );
    return true;
  }
}
