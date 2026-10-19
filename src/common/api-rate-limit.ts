import { Injectable } from "@nestjs/common";
import { ApiException } from "./errors.js";
import { FixedWindowLimiter, type LimitResult } from "./rate-limit.middleware.js";

export type ApiRateLimitConfig = {
  apiPerMinute: number;
  anonymousPerMinute: number;
};

export const apiRateLimiter = new FixedWindowLimiter();

@Injectable()
export class ApiRateLimitService {
  constructor(
    private readonly limiter: FixedWindowLimiter,
    private config: ApiRateLimitConfig,
  ) {}

  configure(config: ApiRateLimitConfig): void {
    this.config = config;
  }

  consumeSession(sessionId: string, now?: number): LimitResult {
    return this.limiter.consumeWithRetryAfter(
      `session:${sessionId}`,
      this.config.apiPerMinute,
      60_000,
      now,
    );
  }

  consumeAnonymous(ip: string, now?: number): LimitResult {
    return this.limiter.consumeWithRetryAfter(
      `ip:${ip}`,
      this.config.anonymousPerMinute,
      60_000,
      now,
    );
  }

  assertAllowed(
    result: LimitResult,
    response: { setHeader(name: string, value: string): void },
  ): void {
    if (result.allowed) return;
    response.setHeader("Retry-After", String(Math.max(1, result.retryAfterSeconds)));
    throw new ApiException("rate_limited", "error.rateLimited", 429);
  }
}

export const API_RATE_LIMIT_SERVICE = Symbol("API_RATE_LIMIT_SERVICE");
