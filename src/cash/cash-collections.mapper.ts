import type { Prisma } from "../generated/prisma/client.js";
import { toArgentinaIso } from "../common/argentina-time.js";
import { cashSafeInteger } from "./cash-sessions.mapper.js";

export const cashReceiptSelect = {
  id: true,
  receiptNumber: true,
  createdAt: true,
  customerId: true,
  customerName: true,
  paymentMethod: true,
  amount: true,
  documentId: true,
  requestFingerprint: true,
  accountEntries: {
    select: {
      type: true,
      amount: true,
      documentId: true,
      document: { select: { internalNumber: true, createdAt: true } },
    },
  },
} as const;
export type CashReceiptRow = Prisma.CashMovementGetPayload<{ select: typeof cashReceiptSelect }>;
export type CashReceiptDto = {
  receiptNumber: string;
  movementId: string;
  occurredAt: string;
  customerId: string;
  customerName: string;
  paymentMethod: "CASH" | "TRANSFER" | "CARD";
  amountCents: number;
  documentId: string | null;
  applications: { documentId: string; documentNumber: string; amountCents: number }[];
  creditGeneratedCents: number;
  customerCreditCents: number;
};

export function mapCashReceipt(row: CashReceiptRow, customerCreditCents: number): CashReceiptDto {
  const applications = row.accountEntries
    .filter((entry) => entry.type === "PAYMENT_APPLIED")
    .sort((left, right) => {
      if (!left.document || !right.document) throw new Error("No se pudo leer el recibo.");
      return (
        left.document.createdAt.getTime() - right.document.createdAt.getTime() ||
        (left.documentId! < right.documentId! ? -1 : left.documentId === right.documentId ? 0 : 1)
      );
    })
    .map((entry) => {
      if (!entry.documentId || !entry.document) throw new Error("No se pudo leer el recibo.");
      return {
        documentId: entry.documentId,
        documentNumber: entry.document.internalNumber,
        amountCents: cashSafeInteger(entry.amount),
      };
    });
  const creditGeneratedCents = cashSafeInteger(
    row.accountEntries
      .filter((entry) => entry.type === "CREDIT_GENERATED")
      .reduce((sum, entry) => sum + BigInt(entry.amount), 0n),
  );
  return {
    receiptNumber: row.receiptNumber,
    movementId: row.id,
    occurredAt: toArgentinaIso(row.createdAt),
    customerId: row.customerId,
    customerName: row.customerName,
    paymentMethod: row.paymentMethod,
    amountCents: cashSafeInteger(row.amount),
    documentId: row.documentId,
    applications,
    creditGeneratedCents,
    customerCreditCents: cashSafeInteger(customerCreditCents),
  };
}
