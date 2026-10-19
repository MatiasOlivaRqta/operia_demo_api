import { describe, expect, it } from "vitest";
import { ApiException } from "../common/errors.js";
import { cashCollectionSchema, validateCollectionKey } from "./cash-collections.schemas.js";

const valid = { customerId: "stable-customer", amountCents: 184200, paymentMethod: "CASH" };
describe("cash collection schemas", () => {
  it("accepts each payment method and integer bounds with optional text document", () => {
    for (const paymentMethod of ["CASH", "TRANSFER", "CARD"])
      for (const amountCents of [1, 2_147_483_647])
        expect(
          cashCollectionSchema.safeParse({
            ...valid,
            paymentMethod,
            amountCents,
            documentId: "pv-0001-00000001",
          }).success,
        ).toBe(true);
  });
  it.each([0, -1, 0.5, 2_147_483_648, "100", null, NaN, Infinity])(
    "rejects amount %s",
    (amountCents) => {
      expect(cashCollectionSchema.safeParse({ ...valid, amountCents }).success).toBe(false);
    },
  );
  it("rejects invalid methods, extra fields and invalid identifiers", () => {
    for (const patch of [
      { paymentMethod: "CHEQUE" },
      { companyId: "other" },
      { customerId: "" },
      { customerId: "c".repeat(101) },
      { documentId: "" },
      { documentId: "d".repeat(101) },
    ])
      expect(cashCollectionSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
  it("accepts keys of length 8 through 100 unchanged", () => {
    for (const key of ["12345678", "k".repeat(100)]) expect(validateCollectionKey(key)).toBe(key);
  });
  it.each([undefined, "", "short", "k".repeat(101)])(
    "rejects invalid key with header field errors",
    (key) => {
      try {
        validateCollectionKey(key);
        throw new Error("Expected rejection");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ApiException);
        if (error instanceof ApiException) {
          expect(error.getStatus()).toBe(400);
          expect(error.code).toBe("validation");
          expect(error.fieldErrors).toEqual({
            "Idempotency-Key": ["El encabezado debe tener entre 8 y 100 caracteres."],
          });
        }
      }
    },
  );
});
