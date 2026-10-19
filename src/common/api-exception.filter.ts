import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { HttpRequest, HttpResponse } from "./http.js";
import { ApiException } from "./errors.js";
import { resolveLocale, t, type MessageKey } from "./i18n/index.js";

type ErrorResponse = {
  error: {
    code: string;
    message: string;
    fieldErrors?: Readonly<Record<string, readonly string[]>>;
  };
};

function isClientErrorStatus(status: unknown): status is number {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<HttpResponse>();
    const request = http.getRequest<HttpRequest>();
    const apiException = exception instanceof ApiException ? exception : null;
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : this.httpErrorStatus(exception) ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const code = apiException?.code ?? this.codeFromStatus(status);
    const locale = resolveLocale(request);
    const message = apiException
      ? t(locale, apiException.messageKey, apiException.params)
      : t(locale, this.messageKeyFromStatus(status));

    if (status >= 500 && status < 600) {
      this.logger.error(`${request.method ?? "UNKNOWN"} ${request.path ?? ""} failed`);
    }
    const body: ErrorResponse = {
      error: {
        code,
        message,
        ...(apiException?.fieldErrors
          ? {
              fieldErrors: Object.fromEntries(
                Object.entries(apiException.fieldMessageKeys ?? apiException.fieldErrors).map(
                  ([field, messages]) => [
                    field,
                    messages.map((message, index) =>
                      t(locale, message, apiException.fieldErrorParams?.[field]?.[index]),
                    ),
                  ],
                ),
              ),
            }
          : {}),
      },
    };
    response.status(status).json(body);
  }

  private httpErrorStatus(exception: unknown): number | null {
    if (typeof exception !== "object" || exception === null) return null;
    const error = exception as { status?: unknown; statusCode?: unknown };
    const status = isClientErrorStatus(error.status) ? error.status : error.statusCode;
    return isClientErrorStatus(status) ? status : null;
  }

  private codeFromStatus(status: number): string {
    if (status === 413) return "payload_too_large";
    if (status === 400) return "validation";
    if (status === 401) return "unauthenticated";
    if (status === 403) return "forbidden";
    if (status === 404) return "not_found";
    if (status === 409) return "conflict";
    if (status === 422) return "business_rule";
    if (status === 429) return "rate_limited";
    return "unexpected";
  }

  private messageKeyFromStatus(status: number): MessageKey {
    if (status === 413) return "error.payloadTooLarge";
    if (status === 400) return "error.validation";
    if (status === 401) return "error.unauthenticated";
    if (status === 403) return "error.forbidden";
    if (status === 404) return "error.notFound";
    if (status === 409) return "error.conflict";
    if (status === 422) return "error.businessRule";
    if (status === 429) return "error.rateLimited";
    return "error.unexpected";
  }
}
