import { describe, expect, it } from "vitest";
import { createLoginRateLimit, FixedWindowLimiter } from "./rate-limit.middleware.js";
import type { HttpRequest, HttpResponse } from "./http.js";

function loginAttempt(
  middleware: ReturnType<typeof createLoginRateLimit>,
  ip: string,
  email: string,
): { allowed: boolean; retryAfter?: string; status?: number; code?: string } {
  const result: { allowed: boolean; retryAfter?: string; status?: number; code?: string } = {
    allowed: false,
  };
  const request = {
    ip,
    socket: { remoteAddress: ip },
    body: { email },
  } as unknown as HttpRequest;
  const response = {
    setHeader(name: string, value: string) {
      if (name === "Retry-After") result.retryAfter = value;
      return this;
    },
    status(status: number) {
      result.status = status;
      return this;
    },
    json(body: { error: { code: string } }) {
      result.code = body.error.code;
      return this;
    },
  } as unknown as HttpResponse;
  middleware(request, response, () => {
    result.allowed = true;
  });
  return result;
}

function loginMiddleware(
  limiter: FixedWindowLimiter,
  ipLimit: number,
  pairLimit: number,
  accountLimit: number,
  now: () => number,
) {
  return createLoginRateLimit(pairLimit, 1, limiter, ipLimit, accountLimit, now);
}

describe("FixedWindowLimiter", () => {
  it("allows the configured number of attempts, blocks the next one, then resets", () => {
    const limiter = new FixedWindowLimiter();

    expect(limiter.consume("account:ip", 2, 1_000, 10_000)).toBe(true);
    expect(limiter.consume("account:ip", 2, 1_000, 10_001)).toBe(true);
    expect(limiter.consume("account:ip", 2, 1_000, 10_002)).toBe(false);
    expect(limiter.consume("account:ip", 2, 1_000, 11_000)).toBe(true);
  });

  it("isolates independent keys and fails closed at its memory ceiling", () => {
    const limiter = new FixedWindowLimiter();

    expect(limiter.consume("first", 1, 60_000, 0)).toBe(true);
    expect(limiter.consume("second", 1, 60_000, 0)).toBe(true);
    for (let index = 0; index < 100_000; index += 1) {
      limiter.consume(`key-${index}`, 1, 60_000, 1);
    }
    expect(limiter.consume("overflow", 1, 60_000, 2)).toBe(false);
  });

  it("clears retained rate-limit state between isolated test contexts", () => {
    const limiter = new FixedWindowLimiter();

    expect(limiter.consume("account:ip", 1, 60_000, 0)).toBe(true);
    expect(limiter.consume("account:ip", 1, 60_000, 1)).toBe(false);
    limiter.reset();
    expect(limiter.consume("account:ip", 1, 60_000, 2)).toBe(true);
  });

  it("returns the seconds until the fixed window ends when blocked", () => {
    const limiter = new FixedWindowLimiter();

    expect(limiter.consumeWithRetryAfter("session:one", 1, 60_000, 10_000)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(limiter.consumeWithRetryAfter("session:one", 1, 60_000, 10_123)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(limiter.consumeWithRetryAfter("session:one", 1, 60_000, 11_001)).toEqual({
      allowed: false,
      retryAfterSeconds: 59,
    });
  });

  it("keeps the memory ceiling at 100,000 retained buckets", () => {
    const limiter = new FixedWindowLimiter();

    for (let index = 0; index < 100_000; index += 1) {
      expect(limiter.consumeWithRetryAfter(`session:${index}`, 1, 60_000, 0).allowed).toBe(true);
    }
    expect(limiter.consumeWithRetryAfter("session:overflow", 1, 60_000, 1).allowed).toBe(false);
  });
});

describe("createLoginRateLimit", () => {
  it("keeps IP buckets independent", () => {
    const middleware = loginMiddleware(new FixedWindowLimiter(), 1, 5, 100, () => 0);

    expect(loginAttempt(middleware, "192.0.2.1", "one@example.com").allowed).toBe(true);
    expect(loginAttempt(middleware, "192.0.2.1", "two@example.com").status).toBe(429);
    expect(loginAttempt(middleware, "192.0.2.2", "one@example.com").allowed).toBe(true);
  });

  it("checks IP, IP+email, then email and stops consuming after a rejection", () => {
    const middleware = loginMiddleware(new FixedWindowLimiter(), 1, 1, 2, () => 0);

    expect(loginAttempt(middleware, "192.0.2.1", "same@example.com").allowed).toBe(true);
    expect(loginAttempt(middleware, "192.0.2.1", "same@example.com").status).toBe(429);
    expect(loginAttempt(middleware, "192.0.2.2", "same@example.com").allowed).toBe(true);
    expect(loginAttempt(middleware, "192.0.2.3", "same@example.com")).toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });

  it("does not let one IP exhaust the account bucket past its IP limit", () => {
    const middleware = loginMiddleware(new FixedWindowLimiter(), 2, 10, 3, () => 0);

    expect(loginAttempt(middleware, "192.0.2.1", "account@example.com").allowed).toBe(true);
    expect(loginAttempt(middleware, "192.0.2.1", "account@example.com").allowed).toBe(true);
    expect(loginAttempt(middleware, "192.0.2.1", "account@example.com").status).toBe(429);
    expect(loginAttempt(middleware, "192.0.2.2", "account@example.com").allowed).toBe(true);
    expect(loginAttempt(middleware, "192.0.2.3", "account@example.com").status).toBe(429);
  });

  it("starts new buckets after the configured window expires", () => {
    let now = 0;
    const middleware = loginMiddleware(new FixedWindowLimiter(), 1, 1, 1, () => now);

    expect(loginAttempt(middleware, "192.0.2.1", "account@example.com").allowed).toBe(true);
    expect(loginAttempt(middleware, "192.0.2.1", "account@example.com").status).toBe(429);
    now = 60_000;
    expect(loginAttempt(middleware, "192.0.2.1", "account@example.com").allowed).toBe(true);
  });
});
