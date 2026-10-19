export type SettlementStatus = "PENDING" | "PARTIAL" | "COMPLETED";

export function settlementStatus(totalCents: number, paidCents: number): SettlementStatus {
  if (paidCents === 0) return "PENDING";
  if (paidCents >= totalCents) return "COMPLETED";
  return "PARTIAL";
}
