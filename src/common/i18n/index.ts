import { Logger } from "@nestjs/common";
import en from "./en.js";
import es from "./es.js";

export type Locale = "es" | "en";
export type MessageKey = keyof typeof es;
export type MessageParams = Readonly<Record<string, string | number>>;
export function messageKey(key: MessageKey): MessageKey {
  return key;
}

const logger = new Logger("i18n");
export function resolveLocale(request: { headers?: { [key: string]: unknown } }): Locale {
  const raw = request.headers?.["accept-language"];
  if (typeof raw !== "string") return "es";
  const accepted = raw
    .split(",")
    .map((part, index) => {
      const [tag = "", ...parameters] = part.trim().split(";");
      const qParam = parameters.find((value) => /^\s*q\s*=/i.test(value));
      const qValue = qParam?.split("=")[1]?.trim();
      const q = qParam
        ? qValue && /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(qValue)
          ? Number(qValue)
          : 0
        : 1;
      const language = tag.trim().toLowerCase().split("-")[0];
      return { language, q, index };
    })
    .filter((item) => item.q > 0 && (item.language === "en" || item.language === "es"))
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return accepted[0]?.language === "en" ? "en" : "es";
}

export function t(locale: Locale, key: MessageKey | string, params: MessageParams = {}): string {
  const english = en[key as MessageKey];
  const spanish = es[key as MessageKey];
  let template = locale === "en" ? (english ?? spanish) : spanish;
  if (template === undefined) {
    logger.warn(`Missing translation key: ${key}`);
    template = key;
  }
  return template.replace(/\{([^}]+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}
