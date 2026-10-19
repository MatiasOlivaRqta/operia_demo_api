import { describe, expect, it } from "vitest";
import { mapCashReceipt, type CashReceiptRow } from "./cash-collections.mapper.js";

const row: CashReceiptRow = {
  id: "movement",
  receiptNumber: "R-0001-00000001",
  createdAt: new Date("2026-10-09T15:00:00Z"),
  customerId: "customer",
  customerName: "Ana",
  paymentMethod: "CASH",
  amount: 200000,
  documentId: "doc",
  requestFingerprint: "private-hash",
  accountEntries: [
    {
      type: "PAYMENT_APPLIED",
      amount: 184200,
      documentId: "doc",
      document: { internalNumber: "0001-00000001", createdAt: new Date("2026-10-01T12:00:00Z") },
    },
    { type: "CREDIT_GENERATED", amount: 15800, documentId: null, document: null },
  ],
};
describe("mapCashReceipt", () => {
  it("returns exactly public fields, applications and the current credit", () => {
    const withPrivateFields = { ...row, companyId: "private", idempotencyKey: "private-key" };
    expect(mapCashReceipt(withPrivateFields, 20000)).toEqual({
      receiptNumber: "R-0001-00000001",
      movementId: "movement",
      occurredAt: "2026-10-09T12:00:00.000-03:00",
      customerId: "customer",
      customerName: "Ana",
      paymentMethod: "CASH",
      amountCents: 200000,
      documentId: "doc",
      applications: [{ documentId: "doc", documentNumber: "0001-00000001", amountCents: 184200 }],
      creditGeneratedCents: 15800,
      customerCreditCents: 20000,
    });
  });
  it("retains the receipt's generated credit while allowing the current balance to change", () => {
    expect(mapCashReceipt(row, 0)).toMatchObject({
      creditGeneratedCents: 15800,
      customerCreditCents: 0,
    });
  });
  it("returns null document and orders applications by document date then id", () => {
    const first = row.accountEntries[0]!;
    const result = mapCashReceipt(
      {
        ...row,
        documentId: null,
        accountEntries: [
          {
            ...first,
            documentId: "z",
            document: { internalNumber: "new", createdAt: new Date("2026-10-02T12:00:00Z") },
          },
          { ...first, documentId: "b" },
          { ...first, documentId: "a" },
        ],
      },
      0,
    );
    expect(result.documentId).toBeNull();
    expect(result.applications.map((application) => application.documentId)).toEqual([
      "a",
      "b",
      "z",
    ]);
    expect(result.creditGeneratedCents).toBe(0);
  });
  it("maps credit only payments with no applications", () => {
    const result = mapCashReceipt(
      {
        ...row,
        documentId: null,
        accountEntries: [
          { type: "CREDIT_GENERATED", amount: 200000, documentId: null, document: null },
        ],
      },
      200000,
    );
    expect(result.applications).toEqual([]);
    expect(result.creditGeneratedCents).toBe(200000);
  });
  it("rejects unsafe current credit and missing document references", () => {
    expect(() => mapCashReceipt(row, Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() =>
      mapCashReceipt(
        {
          ...row,
          accountEntries: [
            { type: "PAYMENT_APPLIED", amount: 1, documentId: null, document: null },
          ],
        },
        0,
      ),
    ).toThrow("No se pudo leer el recibo.");
  });
});
