import { describe, expect, it } from "vitest";
import {
  mapCustomerAccount,
  mapPendingDocument,
  mapApplication,
  mapAccountMovements,
  mapCollectionApplications,
} from "./customer-account.mapper.js";

const document = {
  id: "doc",
  internalNumber: "0001-00000001",
  createdAt: new Date("2026-10-09T12:00:00Z"),
  totalCents: 1000,
  paidCents: 200,
  pendingCents: 800,
  companyId: "hidden",
};
describe("customer account mapper", () => {
  it("maps Argentina dates and omits companyId", () => {
    expect(mapPendingDocument(document)).toEqual({
      id: "doc",
      internalNumber: "0001-00000001",
      date: "2026-10-09T09:00:00.000-03:00",
      totalCents: 1000,
      paidCents: 200,
      pendingCents: 800,
    });
  });
  it("preserves page metadata and full totals, including net credit", () => {
    expect(
      mapCustomerAccount(
        "customer",
        { debtCents: 0, creditCents: 20000 },
        { items: [], total: 0, page: 3, pageSize: 25 },
      ),
    ).toEqual({
      customerId: "customer",
      debtCents: 0,
      creditCents: 20000,
      netBalanceCents: -20000,
      pending: { items: [], total: 0, page: 3, pageSize: 25 },
    });
  });
  it("omits ledger internals from applications", () => {
    expect(
      mapApplication({
        id: "entry",
        companyId: "hidden",
        customerId: "customer",
        type: "CREDIT_APPLIED",
        amount: 200,
        documentId: "doc",
        cashMovementId: null,
        createdAt: document.createdAt,
      }),
    ).toEqual({
      id: "entry",
      customerId: "customer",
      documentId: "doc",
      amountCents: 200,
      createdAt: "2026-10-09T09:00:00.000-03:00",
    });
  });
  it("maps movement dates and calculates balances for collections, cancellations, and credit applications", () => {
    const occurredAt = new Date("2026-10-09T12:00:00Z");
    const items = mapAccountMovements(
      [
        {
          id: "col:1",
          kind: "COLLECTION",
          occurredAt,
          reference: "R-1",
          documentNumber: "0001-1",
          debitCents: 0,
          creditCents: 200000,
          appliedCents: null,
          documentId: null,
          cashMovementId: "movement-1",
        },
        {
          id: "doc:1",
          kind: "DOCUMENT",
          occurredAt,
          reference: "0001-1",
          documentNumber: null,
          debitCents: 184200,
          creditCents: 0,
          appliedCents: null,
          documentId: "doc-1",
          cashMovementId: null,
        },
      ],
      -15800,
    );
    expect(items.map(({ balanceCents }) => balanceCents)).toEqual([-15800, 184200]);
    expect(items[0]).toMatchObject({
      occurredAt: "2026-10-09T09:00:00.000-03:00",
      creditCents: 200000,
      cashMovementId: "movement-1",
    });
    const cancellation = mapAccountMovements(
      [
        {
          id: "can:2",
          kind: "CANCELLATION",
          occurredAt,
          reference: "0001-2",
          documentNumber: null,
          debitCents: 0,
          creditCents: 50000,
          appliedCents: null,
          documentId: "doc-2",
          cashMovementId: null,
        },
        {
          id: "doc:2",
          kind: "DOCUMENT",
          occurredAt,
          reference: "0001-2",
          documentNumber: null,
          debitCents: 50000,
          creditCents: 0,
          appliedCents: null,
          documentId: "doc-2",
          cashMovementId: null,
        },
      ],
      0,
    );
    expect(cancellation.map(({ balanceCents }) => balanceCents)).toEqual([0, 50000]);
    const application = mapAccountMovements(
      [
        {
          id: "app:1",
          kind: "CREDIT_APPLIED",
          occurredAt,
          reference: "0001-3",
          documentNumber: "0001-3",
          debitCents: 0,
          creditCents: 0,
          appliedCents: 10000,
          documentId: "doc-3",
          cashMovementId: null,
        },
        {
          id: "doc:3",
          kind: "DOCUMENT",
          occurredAt,
          reference: "0001-3",
          documentNumber: null,
          debitCents: 10000,
          creditCents: 0,
          appliedCents: null,
          documentId: "doc-3",
          cashMovementId: null,
        },
      ],
      10000,
    );
    expect(application.map(({ balanceCents }) => balanceCents)).toEqual([10000, 10000]);
  });
  it("maps collection applications and Argentine occurrence time", () => {
    expect(
      mapCollectionApplications(
        {
          id: "movement",
          receiptNumber: "R-1",
          paymentMethod: "TRANSFER",
          createdAt: document.createdAt,
          amount: 200000,
        },
        [
          {
            documentId: "doc",
            documentNumber: "0001-00000001",
            amount: 184200,
            status: "PARTIAL",
          },
        ],
        15800,
      ),
    ).toEqual({
      cashMovementId: "movement",
      receiptNumber: "R-1",
      paymentMethod: "TRANSFER",
      occurredAt: "2026-10-09T09:00:00.000-03:00",
      totalCents: 200000,
      documents: [
        {
          documentId: "doc",
          documentNumber: "0001-00000001",
          amountCents: 184200,
          status: "PARTIAL",
        },
      ],
      creditGeneratedCents: 15800,
    });
  });
});
