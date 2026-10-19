import { afterEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "./env.schema.js";

describe("envSchema", () => {
  const base = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/operia",
    DEMO_USER_PASSWORD: "development-password",
    HOGAR_USER_PASSWORD: "another-dev-password",
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function parseCookieSecure(nodeEnv: string, explicitValue?: string) {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.resetModules();
    const { envSchema } = await import("./env.schema.js");
    return envSchema.parse({
      ...base,
      ...(explicitValue === undefined ? {} : { COOKIE_SECURE: explicitValue }),
    }).COOKIE_SECURE;
  }

  it("defaults COOKIE_SECURE from NODE_ENV at schema import time", async () => {
    expect(await parseCookieSecure("production")).toBe(true);
    expect(await parseCookieSecure("development")).toBe(false);
  });

  it("defaults DOCS_ENABLED from NODE_ENV and accepts explicit configuration", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    let schema = await import("./env.schema.js");
    expect(schema.envSchema.parse(base).DOCS_ENABLED).toBe(false);
    expect(schema.envSchema.parse({ ...base, DOCS_ENABLED: "true" }).DOCS_ENABLED).toBe(true);

    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    schema = await import("./env.schema.js");
    expect(schema.envSchema.parse(base).DOCS_ENABLED).toBe(true);
    expect(schema.envSchema.parse({ ...base, DOCS_ENABLED: "false" }).DOCS_ENABLED).toBe(false);
  });

  it("applies the session defaults and validates limits", () => {
    expect(envSchema.parse(base)).toMatchObject({
      SESSION_IDLE_MINUTES: 60,
      SESSION_MAX_PER_USER: 10,
      SESSION_CLEANUP_MINUTES: 60,
    });
    expect(
      envSchema.parse({
        ...base,
        SESSION_IDLE_MINUTES: "0",
        SESSION_MAX_PER_USER: "2",
        SESSION_CLEANUP_MINUTES: "0",
      }),
    ).toMatchObject({
      SESSION_IDLE_MINUTES: 0,
      SESSION_MAX_PER_USER: 2,
      SESSION_CLEANUP_MINUTES: 0,
    });
    expect(envSchema.safeParse({ ...base, SESSION_IDLE_MINUTES: "-1" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, SESSION_IDLE_MINUTES: "1.5" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, SESSION_MAX_PER_USER: "0" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, SESSION_CLEANUP_MINUTES: "-1" }).success).toBe(false);
  });

  it("uses an explicit COOKIE_SECURE value in production", async () => {
    expect(await parseCookieSecure("production", "false")).toBe(false);
  });

  it("allows disabling the mail timer and rejects negative intervals", () => {
    expect(envSchema.parse({ ...base, MAIL_POLL_SECONDS: "0" }).MAIL_POLL_SECONDS).toBe(0);
    expect(envSchema.safeParse({ ...base, MAIL_POLL_SECONDS: -1 }).success).toBe(false);
  });

  it("requires Telegram credentials for polling and accepts polling disabled", () => {
    expect(envSchema.safeParse({ ...base, TELEGRAM_POLL_SECONDS: "1" }).success).toBe(false);
    expect(envSchema.parse({ ...base, TELEGRAM_POLL_SECONDS: "0" })).toMatchObject({
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_BOT_USERNAME: "",
      TELEGRAM_POLL_SECONDS: 0,
    });
    expect(
      envSchema.safeParse({ ...base, TELEGRAM_POLL_SECONDS: "1", TELEGRAM_BOT_TOKEN: "token" })
        .success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...base,
        TELEGRAM_POLL_SECONDS: "1",
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_BOT_USERNAME: "operia_bot",
      }).success,
    ).toBe(true);
    expect(envSchema.safeParse({ ...base, TELEGRAM_BOT_USERNAME: "bad username" }).success).toBe(
      false,
    );
    expect(envSchema.safeParse({ ...base, TELEGRAM_POLL_SECONDS: "3601" }).success).toBe(false);
  });

  it("rejects recipients without SMTP_HOST and MAIL_FROM without exposing values", () => {
    const result = envSchema.safeParse({
      ...base,
      CASH_ALERT_EMAILS: "alerts@example.com",
      SMTP_PASSWORD: "private-smtp-password",
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected invalid configuration");
    expect(result.error.message).toContain("SMTP_HOST");
    expect(result.error.message).toContain("MAIL_FROM");
    for (const value of ["alerts@example.com", "private-smtp-password", base.DEMO_USER_PASSWORD]) {
      expect(result.error.message).not.toContain(value);
    }
  });

  it.each(["not-an-email", "alerts@example.com,", "alerts@example.com,broken"])(
    "rejects malformed recipients: %s",
    (emails) => {
      const result = envSchema.safeParse({ ...base, CASH_ALERT_EMAILS: emails });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).not.toContain(emails);
    },
  );

  it("starts without configured mail and applies mail defaults", () => {
    expect(envSchema.parse(base)).toMatchObject({
      CASH_ALERT_EMAILS: [],
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      MAIL_POLL_SECONDS: 15,
      MAIL_MAX_ATTEMPTS: 6,
    });
    expect(envSchema.safeParse({ ...base, CASH_ALERT_EMAILS: "  " }).success).toBe(true);
  });

  it("accepts trimmed recipients and configured SMTP", () => {
    expect(
      envSchema.parse({
        ...base,
        CASH_ALERT_EMAILS: " alerts@example.com, second@example.com ",
        SMTP_HOST: "mailpit",
        SMTP_PORT: "1025",
        SMTP_SECURE: "false",
        MAIL_FROM: "operia@operia.local",
      }),
    ).toMatchObject({
      CASH_ALERT_EMAILS: ["alerts@example.com", "second@example.com"],
      SMTP_PORT: 1025,
      SMTP_SECURE: false,
    });
  });

  it.each([
    { SMTP_HOST: "smtp://private-host" },
    { SMTP_HOST: "private-host:1025" },
    { SMTP_HOST: "-invalid-host" },
    { MAIL_FROM: "private-invalid-address" },
  ])("rejects invalid mail settings without exposing them", (settings) => {
    const result = envSchema.safeParse({
      ...base,
      CASH_ALERT_EMAILS: "alerts@example.com",
      SMTP_HOST: "mailpit",
      MAIL_FROM: "operia@operia.local",
      ...settings,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      for (const value of Object.values(settings))
        expect(result.error.message).not.toContain(value);
  });
  it("accepts a PostgreSQL URL and applies the default port", () => {
    expect(
      envSchema.parse({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/operia",
        DEMO_USER_PASSWORD: "development-password",
        HOGAR_USER_PASSWORD: "another-dev-password",
      }),
    ).toMatchObject({
      DATABASE_URL: "postgresql://user:pass@localhost:5432/operia",
      PORT: 3001,
      TRUST_PROXY_HOPS: 0,
      RATE_LIMIT_LOGIN_IP_ATTEMPTS: 30,
      RATE_LIMIT_LOGIN_ACCOUNT_ATTEMPTS: 100,
      RATE_LIMIT_API_PER_MINUTE: 600,
      RATE_LIMIT_ANONYMOUS_PER_MINUTE: 100,
    });
  });

  it("accepts proxy and login bucket settings and rejects invalid values", () => {
    expect(
      envSchema.parse({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/operia",
        DEMO_USER_PASSWORD: "development-password",
        HOGAR_USER_PASSWORD: "another-dev-password",
        TRUST_PROXY_HOPS: "1",
        RATE_LIMIT_LOGIN_IP_ATTEMPTS: "40",
        RATE_LIMIT_LOGIN_ACCOUNT_ATTEMPTS: "120",
      }),
    ).toMatchObject({
      TRUST_PROXY_HOPS: 1,
      RATE_LIMIT_LOGIN_IP_ATTEMPTS: 40,
      RATE_LIMIT_LOGIN_ACCOUNT_ATTEMPTS: 120,
    });
    for (const value of ["-1", "1.5", "invalid"]) {
      expect(
        envSchema.safeParse({
          DATABASE_URL: "postgresql://user:pass@localhost:5432/operia",
          DEMO_USER_PASSWORD: "development-password",
          HOGAR_USER_PASSWORD: "another-dev-password",
          TRUST_PROXY_HOPS: value,
        }).success,
      ).toBe(false);
    }
    for (const field of [
      "RATE_LIMIT_LOGIN_IP_ATTEMPTS",
      "RATE_LIMIT_LOGIN_ACCOUNT_ATTEMPTS",
    ] as const) {
      for (const value of ["0", "-1", "1.5", "invalid"]) {
        expect(
          envSchema.safeParse({
            DATABASE_URL: "postgresql://user:pass@localhost:5432/operia",
            DEMO_USER_PASSWORD: "development-password",
            HOGAR_USER_PASSWORD: "another-dev-password",
            [field]: value,
          }).success,
        ).toBe(false);
      }
    }
  });

  it("accepts configurable API limits within the supported range", () => {
    expect(
      envSchema.parse({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/operia",
        DEMO_USER_PASSWORD: "development-password",
        HOGAR_USER_PASSWORD: "another-dev-password",
        RATE_LIMIT_API_PER_MINUTE: "20",
        RATE_LIMIT_ANONYMOUS_PER_MINUTE: "10",
      }),
    ).toMatchObject({ RATE_LIMIT_API_PER_MINUTE: 20, RATE_LIMIT_ANONYMOUS_PER_MINUTE: 10 });
    expect(
      envSchema.safeParse({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/operia",
        DEMO_USER_PASSWORD: "development-password",
        HOGAR_USER_PASSWORD: "another-dev-password",
        RATE_LIMIT_API_PER_MINUTE: 100_001,
      }).success,
    ).toBe(false);
  });

  it("rejects invalid URLs and out-of-range ports", () => {
    expect(
      envSchema.safeParse({
        DATABASE_URL: "not-a-url",
        PORT: 70_000,
        DEMO_USER_PASSWORD: "development-password",
        HOGAR_USER_PASSWORD: "another-dev-password",
      }).success,
    ).toBe(false);
    expect(envSchema.safeParse({ DATABASE_URL: "postgresql://localhost/operia" }).success).toBe(
      false,
    );
  });
});
