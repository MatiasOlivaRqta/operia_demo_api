import { describe, expect, it } from "vitest";
import { ApiRateLimitService } from "./api-rate-limit.js";
import { FixedWindowLimiter } from "./rate-limit.middleware.js";

describe("ApiRateLimitService", () => {
  it("uses a validated session key for authenticated traffic and IP keys for anonymous traffic", () => {
    const service = new ApiRateLimitService(new FixedWindowLimiter(), {
      apiPerMinute: 2,
      anonymousPerMinute: 1,
    });

    expect(service.consumeSession("validated-session").allowed).toBe(true);
    expect(service.consumeSession("validated-session").allowed).toBe(true);
    expect(service.consumeSession("validated-session").allowed).toBe(false);
    expect(service.consumeAnonymous("proxy-ip").allowed).toBe(true);
    expect(service.consumeAnonymous("proxy-ip").allowed).toBe(false);
  });

  it("does not count authenticated requests against the IP bucket", () => {
    const service = new ApiRateLimitService(new FixedWindowLimiter(), {
      apiPerMinute: 10,
      anonymousPerMinute: 1,
    });

    expect(service.consumeSession("session-a").allowed).toBe(true);
    expect(service.consumeAnonymous("proxy-ip").allowed).toBe(true);
    expect(service.consumeAnonymous("proxy-ip").allowed).toBe(false);
  });
});
