import { HttpException, HttpStatus } from "@nestjs/common";
import type { MessageKey, MessageParams } from "./i18n/index.js";
import { t } from "./i18n/index.js";
import { currentRequestLocale } from "./request-context.js";

export type ApiErrorCode =
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "business_rule"
  | "unexpected"
  | "rate_limited"
  | "payload_too_large";

export type FieldErrors = Readonly<Record<string, readonly string[]>>;

export class ApiException extends HttpException {
  readonly fieldErrors?: FieldErrors;
  readonly fieldMessageKeys?: FieldErrors;
  readonly fieldErrorParams?: Readonly<Record<string, readonly MessageParams[]>>;

  constructor(
    readonly code: ApiErrorCode,
    readonly messageKey: MessageKey,
    status: HttpStatus,
    fieldMessageKeys?: FieldErrors,
    readonly params: MessageParams = {},
    fieldErrorParams: Readonly<Record<string, readonly MessageParams[]>> = {},
  ) {
    const locale = currentRequestLocale();
    super(t(locale, messageKey, params), status);
    this.fieldMessageKeys = fieldMessageKeys;
    this.fieldErrorParams = fieldErrorParams;
    this.fieldErrors = fieldMessageKeys
      ? Object.fromEntries(
          Object.entries(fieldMessageKeys).map(([field, messages]) => [
            field,
            messages.map((message, index) => t(locale, message, fieldErrorParams[field]?.[index])),
          ]),
        )
      : undefined;
  }
}
