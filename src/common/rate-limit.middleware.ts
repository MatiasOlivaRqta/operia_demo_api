import type { HttpRequest, HttpResponse, Next } from "./http.js";
import { currentRequestLocale } from "./request-context.js";
import { t } from "./i18n/index.js";

type WindowEntry = { count: number; resetAt: number };
export type LimitResult = { allowed: boolean; retryAfterSeconds: number };

export class FixedWindowLimiter {
  private readonly entries = new Map<string, WindowEntry>();
  private operationCount = 0;

  consume(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    return this.consumeWithRetryAfter(key, limit, windowMs, now).allowed;
  }

  consumeWithRetryAfter(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): LimitResult {
    this.operationCount += 1;
    if (this.operationCount % 256 === 0) {
      for (const [entryKey, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(entryKey);
      }
    }
    if (this.entries.size >= 100_000 && !this.entries.has(key)) {
      let nextResetAt = Number.POSITIVE_INFINITY;
      for (const entry of this.entries.values()) {
        if (entry.resetAt < nextResetAt) nextResetAt = entry.resetAt;
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((nextResetAt - now) / 1_000)),
      };
    }
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
      };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(): void {
    this.entries.clear();
    this.operationCount = 0;
  }
}

function normalizedEmail(request: HttpRequest): string {
  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || !("email" in body)) return "";
  const email = body.email;
  return typeof email === "string" ? email.trim().normalize("NFC").toLowerCase() : "";
}

function clientIp(request: HttpRequest): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

export function rejectRateLimited(response: HttpResponse, retryAfterSeconds = 1): void {
  response.setHeader("Retry-After", String(Math.max(1, retryAfterSeconds)));
  response.status(429).json({
    error: {
      code: "rate_limited",
      message: t(currentRequestLocale(), "error.rateLimited"),
    },
  });
}

export function createApiRateLimit(limiter = new FixedWindowLimiter(), limit = 600) {
  return (request: HttpRequest, response: HttpResponse, next: Next): void => {
    const key = `ip:${clientIp(request)}`;
    const result = limiter.consumeWithRetryAfter(key, limit, 60_000);
    if (!result.allowed) return rejectRateLimited(response, result.retryAfterSeconds);
    next();
  };
}

export function createLoginRateLimit(
  attempts: number,
  windowMinutes: number,
  limiter = new FixedWindowLimiter(),
  ipAttempts = 30,
  accountAttempts = 100,
  now?: () => number,
) {
  return (request: HttpRequest, response: HttpResponse, next: Next): void => {
    const email = normalizedEmail(request);
    const ip = clientIp(request);
    const windowMs = windowMinutes * 60_000;
    const timestamp = now?.();
    for (const [key, limit] of [
      [`login-ip:${ip}`, ipAttempts],
      [`login:${ip}:${email}`, attempts],
      [`login-email:${email}`, accountAttempts],
    ] as const) {
      const result = limiter.consumeWithRetryAfter(key, limit, windowMs, timestamp);
      if (!result.allowed) return rejectRateLimited(response, result.retryAfterSeconds);
    }
    next();
  };
}
