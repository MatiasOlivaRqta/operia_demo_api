import type { Prisma } from "../generated/prisma/client.js";
import { toArgentinaIso } from "../common/argentina-time.js";
import { accountSafeInteger } from "../customer-account/customer-account.service.js";

export const documentSummarySelect = {
  id: true,
  companyId: true,
  customerId: true,
  customerName: true,
  createdAt: true,
  internalNumber: true,
  pointOfSale: true,
  status: true,
  cancellationReason: true,
  totalCents: true,
  _count: { select: { items: true } },
} as const;

export const documentDetailSelect = {
  ...documentSummarySelect,
  requestFingerprint: true,
  items: {
    orderBy: { position: "asc" },
    select: {
      productId: true,
      productName: true,
      sku: true,
      quantity: true,
      unitPriceCents: true,
      discountRate: true,
      taxRate: true,
    },
  },
} as const;

type DocumentSummaryRow = Prisma.DocumentGetPayload<{ select: typeof documentSummarySelect }>;
type DocumentDetailRow = Prisma.DocumentGetPayload<{ select: typeof documentDetailSelect }>;

export type DocumentItemDto = {
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  unitPriceCents: number;
  discountRate: number;
  taxRate: number;
};
export type DocumentSummaryDto = {
  id: string;
  companyId: string;
  customerId: string;
  customerName: string;
  date: string;
  internalNumber: string;
  pointOfSale: string;
  status: DocumentSummaryRow["status"];
  cancelledBy?: string;
  totalCents: number;
  itemCount: number;
};
export type DocumentDto = DocumentSummaryDto & { pendingCents: number; items: DocumentItemDto[] };

export type DocumentCollectionRow = {
  id: string;
  type: "PAYMENT_APPLIED" | "CREDIT_APPLIED";
  amount: number;
  createdAt: Date;
  cashMovement: {
    id: string;
    createdAt: Date;
    paymentMethod: "CASH" | "TRANSFER" | "CARD";
    receiptNumber: string;
  } | null;
};
export type DocumentCollectionItemDto = {
  kind: "PAYMENT" | "CREDIT_APPLIED";
  occurredAt: string;
  amountCents: number;
  paymentMethod: string | null;
  receiptNumber: string | null;
  cashMovementId: string | null;
};
export type DocumentCollectionsDto = {
  items: DocumentCollectionItemDto[];
  totalCents: number;
  paidCents: number;
  pendingCents: number;
};

export function mapDocumentCollections(
  rows: DocumentCollectionRow[],
  balance: { totalCents: number; paidCents: number; pendingCents: number },
): DocumentCollectionsDto {
  const items = rows.map((row): DocumentCollectionItemDto => ({
    kind: row.type === "PAYMENT_APPLIED" ? "PAYMENT" : "CREDIT_APPLIED",
    occurredAt: toArgentinaIso(
      row.type === "PAYMENT_APPLIED"
        ? (row.cashMovement?.createdAt ?? row.createdAt)
        : row.createdAt,
    ),
    amountCents: accountSafeInteger(row.amount),
    paymentMethod:
      row.type === "PAYMENT_APPLIED" ? (row.cashMovement?.paymentMethod ?? null) : null,
    receiptNumber:
      row.type === "PAYMENT_APPLIED" ? (row.cashMovement?.receiptNumber ?? null) : null,
    cashMovementId: row.type === "PAYMENT_APPLIED" ? (row.cashMovement?.id ?? null) : null,
  }));
  const paidCents = accountSafeInteger(
    items.reduce((total, item) => total + BigInt(item.amountCents), 0n),
  );
  if (paidCents !== balance.paidCents)
    throw new RangeError("Las imputaciones no coinciden con el saldo del comprobante.");
  return {
    items,
    totalCents: balance.totalCents,
    paidCents,
    pendingCents: balance.pendingCents,
  };
}

export function mapDocumentSummary(row: DocumentSummaryRow): DocumentSummaryDto {
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    customerName: row.customerName,
    date: row.createdAt.toISOString(),
    internalNumber: row.internalNumber,
    pointOfSale: row.pointOfSale,
    status: row.status,
    ...(row.cancellationReason !== null ? { cancelledBy: row.cancellationReason } : {}),
    totalCents: row.totalCents,
    itemCount: row._count.items,
  };
}

export function mapDocument(
  row: DocumentDetailRow,
  pendingCents = row.status === "COMPLETED" || row.status === "CANCELLED" ? 0 : row.totalCents,
): DocumentDto {
  return {
    ...mapDocumentSummary(row),
    pendingCents,
    items: row.items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      sku: item.sku,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      discountRate: item.discountRate.toNumber(),
      taxRate: item.taxRate.toNumber(),
    })),
  };
}
