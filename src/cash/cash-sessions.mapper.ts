import type { Prisma } from "../generated/prisma/client.js";
import { toArgentinaIso } from "../common/argentina-time.js";

export const cashSessionSelect = {
  id: true,
  status: true,
  openedAt: true,
  openedBy: { select: { name: true, email: true } },
  openingBalance: true,
  closedAt: true,
  declaredBalance: true,
  theoreticalBalance: true,
  difference: true,
  observation: true,
  closedBy: { select: { name: true } },
} as const;
export type CashSessionRow = Prisma.CashSessionGetPayload<{ select: typeof cashSessionSelect }>;
type SessionBase = {
  id: string;
  openedAt: string;
  openedBy: { name: string };
  openingBalanceCents: number;
};
export type CashSessionDto = SessionBase &
  (
    | { status: "OPEN" }
    | {
        status: "CLOSED";
        closedAt: string;
        declaredBalanceCents: number;
        theoreticalBalanceCents: number;
        differenceCents: number;
        observation?: string;
        closedBy: { name: string };
      }
  );

export function cashSafeInteger(value: bigint | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("No se pudieron calcular los importes de caja.");
  return result;
}

export function mapCashSession(row: CashSessionRow): CashSessionDto {
  const base: SessionBase = {
    id: row.id,
    openedAt: toArgentinaIso(row.openedAt),
    openedBy: { name: row.openedBy.name },
    openingBalanceCents: cashSafeInteger(row.openingBalance),
  };
  if (row.status === "OPEN") return { ...base, status: "OPEN" };
  if (
    !row.closedAt ||
    !row.closedBy ||
    row.declaredBalance === null ||
    row.theoreticalBalance === null ||
    row.difference === null
  )
    throw new Error("No se pudo leer la sesión de caja.");
  return {
    ...base,
    status: "CLOSED",
    closedAt: toArgentinaIso(row.closedAt),
    declaredBalanceCents: cashSafeInteger(row.declaredBalance),
    theoreticalBalanceCents: cashSafeInteger(row.theoreticalBalance),
    differenceCents: cashSafeInteger(row.difference),
    ...(row.observation !== null ? { observation: row.observation } : {}),
    closedBy: { name: row.closedBy.name },
  };
}
