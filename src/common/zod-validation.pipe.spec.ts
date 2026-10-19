import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiException } from "./errors.js";
import { runWithRequestLocale } from "./request-context.js";
import { ZodValidationPipe } from "./zod-validation.pipe.js";
import { customerSchema } from "../customers/customer.schemas.js";

describe("ZodValidationPipe localization", () => {
  it.each([
    ["es", "Ingresá un número de documento."],
    ["en", "Enter a document number."],
  ])("localizes customer field errors in %s", (language, expected) => {
    runWithRequestLocale({ headers: { "accept-language": language } } as never, () => {
      try {
        new ZodValidationPipe(customerSchema).transform({ documentNumber: "" });
        throw new Error("Expected validation to fail");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ApiException);
        expect((error as ApiException).fieldErrors?.documentNumber).toEqual([expected]);
      }
    });
  });

  it.each([
    ["es", "El valor debe ser como máximo 4."],
    ["en", "The value must be at most 4."],
  ])("includes numeric limits in %s", (language, expected) => {
    runWithRequestLocale({ headers: { "accept-language": language } } as never, () => {
      try {
        new ZodValidationPipe(z.string().max(4)).transform("12345");
        throw new Error("Expected validation to fail");
      } catch (error: unknown) {
        expect((error as ApiException).fieldErrors?.body).toEqual([expected]);
      }
    });
  });
});
