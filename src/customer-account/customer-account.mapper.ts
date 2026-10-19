import type { AccountEntry } from "../generated/prisma/client.js";
import { toArgentinaIso } from "../common/argentina-time.js";
import type { Page } from "../common/pagination.js";
import type { AccountTotals, PendingDocument } from "./customer-account.service.js";
import { accountSafeInteger } from "./customer-account.service.js";
import type { AccountMovementKind } from "./customer-account.schemas.js";

export type AccountMovement = {
  id: string;
  kind: AccountMovementKind;
  occurredAt: Date;
  reference: string;
  documentNumber: string | null;
  debitCents: number;
  creditCents: number;
  appliedCents: number | null;
  documentId: string | null;
  cashMovementId: string | null;
};

export type CollectionApplicationRow = {
  documentId: string;
  documentNumber: string;
  amount: number | bigint;
  status: "PENDING" | "PARTIAL" | "COMPLETED" | "CANCELLED";
};

export function mapCollectionApplications(
  cashMovement: {
    id: string;
    receiptNumber: string | null;
    paymentMethod: "CASH" | "TRANSFER" | "CARD";
    createdAt: Date;
    amount: number | bigint;
  },
  rows: CollectionApplicationRow[],
  creditGenerated: number | bigint,
) {
  return {
    cashMovementId: cashMovement.id,
    receiptNumber: cashMovement.receiptNumber,
    paymentMethod: cashMovement.paymentMethod,
    occurredAt: toArgentinaIso(cashMovement.createdAt),
    totalCents: accountSafeInteger(cashMovement.amount),
    documents: rows.map((row) => ({
      documentId: row.documentId,
      documentNumber: row.documentNumber,
      amountCents: accountSafeInteger(row.amount),
      status: row.status,
    })),
    creditGeneratedCents: accountSafeInteger(creditGenerated),
  };
}

export function mapAccountMovements(rows: readonly AccountMovement[], startingBalance: number) {
  let balanceCents = startingBalance;
  return rows.map((row) => {
    const mapped = {
      ...row,
      occurredAt: toArgentinaIso(row.occurredAt),
      balanceCents,
    };
    balanceCents -= row.debitCents - row.creditCents;
    if (!Number.isSafeInteger(balanceCents)) throw new RangeError("Saldo fuera del rango seguro.");
    return mapped;
  });
}

export function mapPendingDocument(document: PendingDocument) {
  return {
    id: document.id,
    internalNumber: document.internalNumber,
    date: toArgentinaIso(document.createdAt),
    totalCents: document.totalCents,
    paidCents: document.paidCents,
    pendingCents: document.pendingCents,
  };
}
export function mapCustomerAccount(
  customerId: string,
  totals: AccountTotals,
  pending: Page<PendingDocument>,
) {
  const netBalanceCents = totals.debtCents - totals.creditCents;
  if (!Number.isSafeInteger(netBalanceCents)) throw new RangeError("Saldo fuera del rango seguro.");
  return {
    customerId,
    debtCents: totals.debtCents,
    creditCents: totals.creditCents,
    netBalanceCents,
    pending: {
      page: pending.page,
      pageSize: pending.pageSize,
      total: pending.total,
      items: pending.items.map(mapPendingDocument),
    },
  };
}
export function mapApplication(application: AccountEntry) {
  return {
    id: application.id,
    customerId: application.customerId,
    documentId: application.documentId,
    amountCents: application.amount,
    createdAt: toArgentinaIso(application.createdAt),
  };
}
