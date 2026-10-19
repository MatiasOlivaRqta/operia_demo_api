import express from "express";
import helmet from "helmet";
import type { INestApplication } from "@nestjs/common";
import type { Next, HttpRequest, HttpResponse } from "./http.js";
import { env } from "../config/env.js";
import { ApiExceptionFilter } from "./api-exception.filter.js";
import { createLoginRateLimit, FixedWindowLimiter } from "./rate-limit.middleware.js";
import { apiRateLimiter } from "./api-rate-limit.js";
import { currentRequestLocale, runWithRequestLocale } from "./request-context.js";
import { t } from "./i18n/index.js";

export function configureHttpSecurity(app: INestApplication): () => void {
  const origins = env.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set("trust proxy", env.TRUST_PROXY_HOPS);
  expressApp.disable("x-powered-by");
  app.use(helmet());
  app.use((_request: HttpRequest, response: HttpResponse, next: Next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.use((request: HttpRequest, _response: HttpResponse, next: Next) =>
    runWithRequestLocale(request, next),
  );
  app.enableCors({
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => callback(null, origin === undefined || origins.includes(origin)),
  });
  const loginLimiter = new FixedWindowLimiter();
  app.use(
    "/auth/login",
    createLoginRateLimit(
      env.RATE_LIMIT_LOGIN_ATTEMPTS,
      env.RATE_LIMIT_LOGIN_WINDOW_MINUTES,
      loginLimiter,
      env.RATE_LIMIT_LOGIN_IP_ATTEMPTS,
      env.RATE_LIMIT_LOGIN_ACCOUNT_ATTEMPTS,
    ),
  );
  app.use((request: HttpRequest, response: HttpResponse, next: Next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) return next();
    const sourceHeader = request.headers.origin ?? request.headers.referer;
    const source = typeof sourceHeader === "string" ? sourceHeader : undefined;
    if (sourceHeader === undefined) return next();
    if (source === undefined) {
      response.status(403).json({
        error: {
          code: "forbidden",
          message: t(currentRequestLocale(), "security.origin.forbidden"),
        },
      });
      return;
    }
    let sourceOrigin: string;
    try {
      sourceOrigin = new URL(source).origin;
    } catch {
      response.status(403).json({
        error: {
          code: "forbidden",
          message: t(currentRequestLocale(), "security.origin.forbidden"),
        },
      });
      return;
    }
    if (!origins.includes(sourceOrigin)) {
      response.status(403).json({
        error: {
          code: "forbidden",
          message: t(currentRequestLocale(), "security.origin.forbidden"),
        },
      });
      return;
    }
    next();
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  return () => {
    apiRateLimiter.reset();
    loginLimiter.reset();
  };
}
