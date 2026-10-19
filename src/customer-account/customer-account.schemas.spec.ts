import { describe, expect, it } from "vitest";
import { ApiException } from "../common/errors.js";
import {
  accountCustomerParamsSchema,
  accountCollectionParamsSchema,
  accountMovementDtoSchema,
  accountQuerySchema,
  accountApplicationSchema,
  accountMovementsQuerySchema,
  decodeAccountMovementCursor,
  encodeAccountMovementCursor,
} from "./customer-account.schemas.js";

describe("customer account schemas", () => {
  it("accepts positive Int cents and rejects extra or invalid application fields", () => {
    expect(accountApplicationSchema.parse({ documentId: "doc", amountCents: 1 })).toEqual({
      documentId: "doc",
      amountCents: 1,
    });
    for (const amountCents of [0, -1, 1.5, 2_147_483_648, "1"])
      expect(accountApplicationSchema.safeParse({ documentId: "doc", amountCents }).success).toBe(
        false,
      );
    expect(
      accountApplicationSchema.safeParse({
        documentId: "doc",
        amountCents: 1,
        companyId: "foreign",
      }).success,
    ).toBe(false);
    expect(accountApplicationSchema.safeParse({ documentId: "", amountCents: 1 }).success).toBe(
      false,
    );
  });
  it("accepts stable ids and enforces length and strict fields", () => {
    expect(accountCustomerParamsSchema.parse({ id: "demo-customer" })).toEqual({
      id: "demo-customer",
    });
    for (const value of [
      { id: "" },
      { id: "x".repeat(101) },
      { id: 1 },
      { id: "ok", companyId: "foreign" },
    ])
      expect(accountCustomerParamsSchema.safeParse(value).success).toBe(false);
  });
  it("validates collection detail path ids using the account id format", () => {
    expect(
      accountCollectionParamsSchema.parse({ id: "customer", cashMovementId: "movement" }),
    ).toEqual({
      id: "customer",
      cashMovementId: "movement",
    });
    for (const value of [
      { id: "", cashMovementId: "movement" },
      { id: "customer", cashMovementId: "" },
      { id: "x".repeat(101), cashMovementId: "movement" },
      { id: "customer", cashMovementId: "movement", extra: "no" },
    ])
      expect(accountCollectionParamsSchema.safeParse(value).success).toBe(false);
  });
  it("parses pagination defaults and rejects unsupported query fields", () => {
    expect(accountQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(accountQuerySchema.parse({ page: "2", pageSize: "100" })).toEqual({
      page: 2,
      pageSize: 100,
    });
    for (const value of [{ page: 0 }, { pageSize: 101 }, { page: 1.5 }, { companyId: "foreign" }])
      expect(accountQuerySchema.safeParse(value).success).toBe(false);
  });
  it("round trips a canonical account movement cursor and rejects malformed or altered data", () => {
    const cursor = { t: "2026-10-09T12:00:00.000Z", k: 3, id: "col:movement-1" };
    const encoded = encodeAccountMovementCursor(cursor);
    expect(decodeAccountMovementCursor(encoded)).toEqual(cursor);
    const manipulated = encodeAccountMovementCursor({ ...cursor, k: 99 });
    for (const altered of ["!not-base64url!", manipulated]) {
      try {
        decodeAccountMovementCursor(altered);
        throw new Error("Expected an invalid cursor to be rejected.");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ApiException);
        if (error instanceof ApiException) {
          expect(error.code).toBe("validation");
          expect(error.getStatus()).toBe(400);
          expect(error.fieldErrors).toMatchObject({ cursor: [expect.any(String)] });
        }
      }
    }
  });
  it("validates movement query limits and defaults", () => {
    expect(accountMovementsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(accountMovementsQuerySchema.parse({ limit: "100" })).toEqual({ limit: 100 });
    for (const value of [{ limit: "0" }, { limit: "101" }, { extra: "1" }])
      expect(accountMovementsQuerySchema.safeParse(value).success).toBe(false);
  });
  it("validates nullable movement relation identifiers", () => {
    const base = {
      id: "doc:1",
      kind: "DOCUMENT",
      occurredAt: "2026-10-09T09:00:00.000-03:00",
      reference: "0001-1",
      documentNumber: null,
      debitCents: 100,
      creditCents: 0,
      appliedCents: null,
      balanceCents: 100,
    };
    expect(
      accountMovementDtoSchema.parse({ ...base, documentId: "doc-1", cashMovementId: null }),
    ).toMatchObject({
      documentId: "doc-1",
      cashMovementId: null,
    });
    expect(
      accountMovementDtoSchema.parse({ ...base, documentId: null, cashMovementId: "cash-1" }),
    ).toMatchObject({
      documentId: null,
      cashMovementId: "cash-1",
    });
    expect(
      accountMovementDtoSchema.safeParse({ ...base, documentId: undefined, cashMovementId: null })
        .success,
    ).toBe(false);
  });
});
