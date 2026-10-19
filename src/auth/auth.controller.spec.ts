import { describe, expect, it, vi } from "vitest";
import type { HttpResponse } from "../common/http.js";
import type { SessionContext } from "../common/request-context.js";
import { IS_PUBLIC_KEY } from "../common/public.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../permissions/require-permission.decorator.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";

describe("AuthController.logoutAll", () => {
  it("closes every session for the current user and clears the cookie", async () => {
    const auth = { logoutAll: vi.fn().mockResolvedValue(undefined) };
    const controller = new AuthController(auth as unknown as AuthService);
    const response = {
      clearCookie: vi.fn(),
      setHeader: vi.fn(),
    } as unknown as HttpResponse;
    const session: SessionContext = {
      userId: "user-id",
      companyId: "company-id",
      sessionId: "session-id",
      permissions: [],
    };

    await controller.logoutAll(session, response);

    expect(auth.logoutAll).toHaveBeenCalledWith("user-id");
    expect(response.clearCookie).toHaveBeenCalledWith(AuthService.cookieName(), {
      httpOnly: true,
      secure: expect.any(Boolean),
      sameSite: "lax",
      path: "/",
    });
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it("keeps logout-all outside the permission decorator and under the session guard", () => {
    const metadata = Reflect.getMetadata("path", AuthController.prototype.logoutAll);
    expect(metadata).toBe("logout-all");
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AuthController.prototype.logoutAll)).toBeUndefined();
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AuthController.prototype.logoutAll),
    ).toBeUndefined();
  });
});
