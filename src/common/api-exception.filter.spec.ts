import { ArgumentsHost, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiException, type ApiErrorCode } from "./errors.js";
import { ApiExceptionFilter } from "./api-exception.filter.js";
import { messageKey } from "./i18n/index.js";
import type { MessageKey } from "./i18n/index.js";

const cases = [
  { code: "validation", status: HttpStatus.BAD_REQUEST },
  { code: "unauthenticated", status: HttpStatus.UNAUTHORIZED },
  { code: "forbidden", status: HttpStatus.FORBIDDEN },
  { code: "not_found", status: HttpStatus.NOT_FOUND },
  { code: "conflict", status: HttpStatus.CONFLICT },
  { code: "business_rule", status: HttpStatus.UNPROCESSABLE_ENTITY },
  { code: "unexpected", status: HttpStatus.INTERNAL_SERVER_ERROR },
  { code: "rate_limited", status: HttpStatus.TOO_MANY_REQUESTS },
] as const satisfies readonly { code: ApiErrorCode; status: HttpStatus }[];

describe("ApiExceptionFilter", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(cases)("keeps the stable envelope for $code", ({ code, status }) => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const filter = new ApiExceptionFilter();
    const exception = new ApiException(code, messageKey("customer.notFound"), status, {
      cuit: [messageKey("validation.customer.cuit")],
    });
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    filter.catch(exception, createHost(response, "es"));

    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code,
        message: "No encontramos el cliente de la empresa activa.",
        fieldErrors: { cuit: ["Ingresá un CUIT/CUIL válido."] },
      },
    });
  });

  it("translates exception and field messages from the request header", () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    new ApiExceptionFilter().catch(
      new ApiException("not_found", messageKey("customer.notFound"), 404),
      createHost(response, "en"),
    );
    expect(response.json).toHaveBeenCalledWith({
      error: { code: "not_found", message: "The customer for the active company was not found." },
    });
  });

  it("uses the key for an unknown translation without throwing", () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const warning = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    new ApiExceptionFilter().catch(
      new ApiException("not_found", "missing.translation" as MessageKey, 404),
      createHost(response, "en"),
    );
    expect(response.json).toHaveBeenCalledWith({
      error: { code: "not_found", message: "missing.translation" },
    });
    expect(warning).toHaveBeenCalledWith("Missing translation key: missing.translation");
  });

  it("localizes default messages and hides internal exception text", () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const loggerError = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    new ApiExceptionFilter().catch(
      new HttpException("database password", HttpStatus.INTERNAL_SERVER_ERROR),
      createHost(response, "en"),
    );
    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: "unexpected", message: "An internal error occurred." },
    });
    expect(JSON.stringify(response.json.mock.calls)).not.toContain("database password");
    expect(loggerError).toHaveBeenCalledOnce();
  });

  it.each([
    ["es", "El cuerpo de la solicitud supera el tamaño máximo permitido."],
    ["en", "The request body exceeds the maximum allowed size."],
  ])("maps oversized http-errors to a localized 413 (%s)", (language, message) => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const loggerError = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    new ApiExceptionFilter().catch(
      Object.assign(new Error("too large"), { statusCode: 413 }),
      createHost(response, language),
    );

    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: "payload_too_large", message },
    });
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("keeps malformed JSON http-errors as the existing 400 response", () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const loggerError = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    new ApiExceptionFilter().catch(
      Object.assign(new SyntaxError("Unexpected token"), { status: 400, type: "entity.parse.failed" }),
      createHost(response, "es"),
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: "validation", message: "La solicitud no es válida." },
    });
    expect(loggerError).not.toHaveBeenCalled();
  });
});

function createHost(
  response: { status: (code: number) => unknown; json: (body: unknown) => unknown },
  language?: string,
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({
        method: "GET",
        path: "/test",
        headers: language ? { "accept-language": language } : {},
      }),
    }),
  } as unknown as ArgumentsHost;
}
