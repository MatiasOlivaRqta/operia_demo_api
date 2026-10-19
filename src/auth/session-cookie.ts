import { env } from "../config/env.js";
import type { HttpResponse } from "../common/http.js";
import { AuthService } from "./auth.service.js";

export function clearSessionCookie(response: HttpResponse): void {
  response.clearCookie(AuthService.cookieName(), {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
  });
}
