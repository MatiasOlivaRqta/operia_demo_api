import { isIP } from "node:net";
import { z } from "zod";
import { messageKey } from "../common/i18n/index.js";

export const envSchema = z
  .object({
    DATABASE_URL: z.url(),
    DATABASE_URL_TEST: z.url().optional(),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
    GEOREF_BASE_URL: z.url().default("https://apis.datos.gob.ar/georef/api"),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(8),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(0).default(60),
    SESSION_MAX_PER_USER: z.coerce.number().int().min(1).default(10),
    SESSION_CLEANUP_MINUTES: z.coerce.number().int().min(0).default(60),
    DOCS_ENABLED: z.stringbool().default(process.env.NODE_ENV !== "production"),
    COOKIE_SECURE: z.stringbool().default(process.env.NODE_ENV === "production"),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    DEMO_USER_EMAIL: z.email().default("demo@operia.local"),
    DEMO_USER_PASSWORD: z.string().min(12),
    HOGAR_USER_EMAIL: z.email().default("hogar@operia.local"),
    HOGAR_USER_PASSWORD: z.string().min(12),
    RATE_LIMIT_LOGIN_ATTEMPTS: z.coerce.number().int().positive().default(5),
    RATE_LIMIT_LOGIN_IP_ATTEMPTS: z.coerce.number().int().positive().default(30),
    RATE_LIMIT_LOGIN_ACCOUNT_ATTEMPTS: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
    RATE_LIMIT_API_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
    RATE_LIMIT_ANONYMOUS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(100),
    CASH_ALERT_EMAILS: z
      .string()
      .default("")
      .transform((value) =>
        value.trim() === "" ? [] : value.split(",").map((email) => email.trim()),
      )
      .pipe(z.array(z.email({ error: messageKey("config.cashAlertEmails.invalid") }))),
    SMTP_HOST: z.string().trim().default(""),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    SMTP_SECURE: z.stringbool().default(false),
    SMTP_USER: z.string().default(""),
    SMTP_PASSWORD: z.string().default(""),
    MAIL_FROM: z.string().trim().default(""),
    MAIL_POLL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(15),
    MAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(6),
    TELEGRAM_BOT_TOKEN: z.string().trim().default(""),
    TELEGRAM_BOT_USERNAME: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]*$/)
      .default(""),
    TELEGRAM_POLL_SECONDS: z.coerce.number().int().min(0).max(3600).default(0),
  })
  .superRefine((config, ctx) => {
    if (config.CASH_ALERT_EMAILS.length > 0) {
      const hostname = config.SMTP_HOST.replace(/\.$/, "");
      const validHostname =
        hostname.length > 0 &&
        hostname.length <= 253 &&
        hostname.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
      if (!validHostname && isIP(config.SMTP_HOST) === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["SMTP_HOST"],
          message: messageKey("config.smtpHost.invalid"),
        });
      }
      if (!z.email().safeParse(config.MAIL_FROM).success) {
        ctx.addIssue({
          code: "custom",
          path: ["MAIL_FROM"],
          message: messageKey("config.mailFrom.invalid"),
        });
      }
    }
    if (config.TELEGRAM_POLL_SECONDS > 0) {
      if (!config.TELEGRAM_BOT_TOKEN.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["TELEGRAM_BOT_TOKEN"],
          message: messageKey("config.telegram.token.required"),
        });
      }
      if (!config.TELEGRAM_BOT_USERNAME.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["TELEGRAM_BOT_USERNAME"],
          message: messageKey("config.telegram.username.required"),
        });
      }
    }
  });
