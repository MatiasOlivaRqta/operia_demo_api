import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from "@nestjs/common";
import type { HttpResponse } from "../common/http.js";
import { readCookie } from "../common/cookie.js";
import { Public } from "../common/public.decorator.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import type { AuthenticatedRequest } from "../common/request-context.js";
import { loginSchema, type LoginInput } from "./auth.schemas.js";
import { AuthService } from "./auth.service.js";
import { env } from "../config/env.js";
import { CurrentSession } from "../common/request-context.js";
import type { SessionContext } from "../common/request-context.js";
import { clearSessionCookie } from "./session-cookie.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) input: LoginInput,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const result = await this.auth.login(input);
    response.cookie(AuthService.cookieName(), result.token, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: "lax",
      path: "/",
      expires: result.expiresAt,
    });
    response.setHeader("Cache-Control", "no-store");
    return result.payload;
  }

  @Public()
  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<void> {
    await this.auth.logout(readCookie(request, AuthService.cookieName()));
    clearSessionCookie(response);
    response.setHeader("Cache-Control", "no-store");
  }

  @Post("logout-all")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentSession() session: SessionContext,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<void> {
    await this.auth.logoutAll(session.userId);
    clearSessionCookie(response);
    response.setHeader("Cache-Control", "no-store");
  }

  @Get("me")
  async me(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const token = readCookie(request, AuthService.cookieName());
    response.setHeader("Cache-Control", "no-store");
    return this.auth.getSession(token);
  }
}
