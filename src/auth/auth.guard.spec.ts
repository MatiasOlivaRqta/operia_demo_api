import { describe, expect, it, vi } from "vitest";
import { ApiException } from "../common/errors.js";
import { messageKey } from "../common/i18n/index.js";
import type { AuthenticatedRequest } from "../common/request-context.js";
import type { HttpResponse } from "../common/http.js";
import { env } from "../config/env.js";
import { AuthService } from "./auth.service.js";
import { AuthGuard } from "./auth.guard.js";

function createContext(request: AuthenticatedRequest, response: HttpResponse) {
  return {
    getHandler: vi.fn(),
    getClass: vi.fn(),
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  };
}

describe("AuthGuard", () => {
  it.each([`operia_session=invalid`, `other=value; operia_session=`])(
    "clears the session cookie on 401 when the request includes it (%s)",
    async (cookie) => {
      const auth = {
        authenticate: vi
          .fn()
          .mockRejectedValue(
            new ApiException("unauthenticated", messageKey("error.unauthenticated"), 401),
          ),
      };
      const rateLimit = { consumeAnonymous: vi.fn(() => ({})), assertAllowed: vi.fn() };
      const response = { clearCookie: vi.fn() } as unknown as HttpResponse;
      const request = { headers: { cookie }, ip: "127.0.0.1", socket: {} } as AuthenticatedRequest;
      const reflector = { getAllAndOverride: vi.fn(() => false) };
      const guard = new AuthGuard(
        reflector as never,
        auth as unknown as AuthService,
        rateLimit as never,
      );

      await expect(
        guard.canActivate(createContext(request, response) as never),
      ).rejects.toMatchObject({ status: 401 });

      expect(response.clearCookie).toHaveBeenCalledWith(AuthService.cookieName(), {
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: "lax",
        path: "/",
      });
    },
  );

  it("does not clear a cookie when the request has none", async () => {
    const auth = {
      authenticate: vi
        .fn()
        .mockRejectedValue(
          new ApiException("unauthenticated", messageKey("error.unauthenticated"), 401),
        ),
    };
    const rateLimit = { consumeAnonymous: vi.fn(() => ({})), assertAllowed: vi.fn() };
    const response = { clearCookie: vi.fn() } as unknown as HttpResponse;
    const request = { headers: {}, ip: "127.0.0.1", socket: {} } as AuthenticatedRequest;
    const reflector = { getAllAndOverride: vi.fn(() => false) };
    const guard = new AuthGuard(
      reflector as never,
      auth as unknown as AuthService,
      rateLimit as never,
    );

    await expect(
      guard.canActivate(createContext(request, response) as never),
    ).rejects.toMatchObject({ status: 401 });
    expect(response.clearCookie).not.toHaveBeenCalled();
  });
});
