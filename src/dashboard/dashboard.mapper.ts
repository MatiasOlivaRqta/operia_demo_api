import { accountSafeInteger } from "../customer-account/customer-account.service.js";
import { toArgentinaIso } from "../common/argentina-time.js";
import type { DashboardActivityItem } from "./dashboard.schemas.js";

export type DashboardActivityRow = {
  kind: "document" | "collection" | "stock_movement";
  id: string;
  occurredAt: Date;
  reference: string;
  counterparty: string;
  amountCents: bigint | null;
  quantity: bigint | null;
  status: string;
  refId: string;
};

export function mapDashboardActivityRow(row: DashboardActivityRow): DashboardActivityItem {
  const base = {
    id: row.id,
    occurredAt: toArgentinaIso(row.occurredAt),
    reference: row.reference,
    counterparty: row.counterparty,
    refId: row.refId,
  };
  if (row.kind === "document") {
    if (
      row.status !== "PENDING" &&
      row.status !== "PARTIAL" &&
      row.status !== "COMPLETED" &&
      row.status !== "CANCELLED"
    )
      throw new RangeError("Estado de comprobante inválido.");
    if (row.amountCents === null) throw new RangeError("El comprobante no tiene importe.");
    return {
      ...base,
      kind: row.kind,
      amountCents: accountSafeInteger(row.amountCents),
      status: row.status,
    };
  }
  if (row.kind === "collection") {
    if (row.amountCents === null) throw new RangeError("El cobro no tiene importe.");
    return {
      ...base,
      kind: row.kind,
      amountCents: accountSafeInteger(row.amountCents),
      status: "COLLECTED",
    };
  }
  if (row.kind === "stock_movement") {
    if (row.quantity === null) throw new RangeError("El movimiento no tiene cantidad.");
    if (
      !(["INGRESO", "SALIDA", "AJUSTE", "REVERSION"] as const).includes(
        row.status as "INGRESO" | "SALIDA" | "AJUSTE" | "REVERSION",
      )
    )
      throw new RangeError("Tipo de movimiento inválido.");
    return {
      ...base,
      kind: row.kind,
      quantity: accountSafeInteger(row.quantity),
      status: row.status as "INGRESO" | "SALIDA" | "AJUSTE" | "REVERSION",
    };
  }
  throw new RangeError("Tipo de actividad inválido.");
}
