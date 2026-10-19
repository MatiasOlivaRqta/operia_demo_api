import type { Prisma } from "../generated/prisma/client.js";
import { toArgentinaIso } from "../common/argentina-time.js";

export const cashMovementSelect = {
  id: true,
  createdAt: true,
  type: true,
  customerId: true,
  customerName: true,
  receiptNumber: true,
  documentNumber: true,
  paymentMethod: true,
  amount: true,
} as const;

export type CashMovementRow = Prisma.CashMovementGetPayload<{ select: typeof cashMovementSelect }>;
export type CashMovementDto = {
  id: string;
  occurredAt: string;
  type: "COBRO";
  customerId: string;
  customerName: string;
  receiptNumber: string;
  documentNumber: string | null;
  paymentMethod: "CASH" | "TRANSFER" | "CARD";
  amountCents: number;
};

export function mapCashMovement(row: CashMovementRow): CashMovementDto {
  return {
    id: row.id,
    occurredAt: toArgentinaIso(row.createdAt),
    type: row.type,
    customerId: row.customerId,
    customerName: row.customerName,
    receiptNumber: row.receiptNumber,
    documentNumber: row.documentNumber,
    paymentMethod: row.paymentMethod,
    amountCents: row.amount,
  };
}
