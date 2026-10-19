import { messageKey } from "../common/i18n/index.js";
import { Injectable } from "@nestjs/common";
import { Prisma, type CashPaymentMethod } from "../generated/prisma/client.js";
import { ApiException } from "../common/errors.js";
import {
  argentinaDayEndExclusive,
  argentinaDayStart,
  todayInArgentina,
  toArgentinaIso,
} from "../common/argentina-time.js";
import { paginate, type Page } from "../common/pagination.js";
import type { SessionContext } from "../common/request-context.js";
import { DatabaseService } from "../database/database.service.js";
import { cashMovementSelect, mapCashMovement, type CashMovementDto } from "./cash.mapper.js";
import type { CashMovementQuery } from "./cash.schemas.js";

type Period = { from?: string; to?: string; sessionId?: string };
export function buildCashMovementWhere(
  companyId: string,
  query: Period,
  now: Date = new Date(),
): Prisma.CashMovementWhereInput {
  const dateFilter =
    query.from && query.to
      ? { gte: argentinaDayStart(query.from), lt: argentinaDayEndExclusive(query.to) }
      : !query.sessionId
        ? (() => {
            const [year, month, day] = todayInArgentina(now).split("-").map(Number);
            const end = new Date(Date.UTC(year!, month! - 1, day!));
            end.setUTCDate(end.getUTCDate() - 29);
            const from = `${end.getUTCFullYear().toString().padStart(4, "0")}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}`;
            const today = todayInArgentina(now);
            return { gte: argentinaDayStart(from), lt: argentinaDayEndExclusive(today) };
          })()
        : undefined;
  return {
    companyId,
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...("paymentMethod" in query && query.paymentMethod
      ? { paymentMethod: query.paymentMethod as CashPaymentMethod }
      : {}),
    ...("customerId" in query && query.customerId ? { customerId: query.customerId } : {}),
    ...(dateFilter ? { createdAt: dateFilter } : {}),
  };
}

type MethodTotals = {
  byMethod: Record<CashPaymentMethod, number>;
  netCollectedCents: number;
  movementsCount: number;
  theoreticalCashCents: number;
};
export function calculateCashTotals(
  openingBalanceCents: number,
  rows: ReadonlyArray<{ paymentMethod: CashPaymentMethod; amount: number | null; count: number }>,
): MethodTotals {
  const byMethod: Record<CashPaymentMethod, number> = { CASH: 0, TRANSFER: 0, CARD: 0 };
  let movementsCount = 0;
  for (const row of rows) {
    const amount = row.amount ?? 0;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(row.count))
      throw new Error("No se pudieron calcular los totales de caja.");
    byMethod[row.paymentMethod] = amount;
    movementsCount += row.count;
  }
  const netCollectedCents = byMethod.CASH + byMethod.TRANSFER + byMethod.CARD;
  const theoreticalCashCents = openingBalanceCents + byMethod.CASH;
  if (
    ![
      openingBalanceCents,
      movementsCount,
      netCollectedCents,
      theoreticalCashCents,
      ...Object.values(byMethod),
    ].every(Number.isSafeInteger)
  )
    throw new Error("No se pudieron calcular los totales de caja.");
  return { byMethod, netCollectedCents, movementsCount, theoreticalCashCents };
}

@Injectable()
export class CashService {
  constructor(private readonly database: DatabaseService) {}

  async listMovements(
    session: SessionContext,
    query: CashMovementQuery,
  ): Promise<Page<CashMovementDto>> {
    if (query.sessionId) {
      const owned = await this.database.cashSession.findUnique({
        where: { id_companyId: { id: query.sessionId, companyId: session.companyId } },
        select: { id: true },
      });
      if (!owned) throw new ApiException("not_found", messageKey("cash.session.notFound"), 404);
    }
    const where = buildCashMovementWhere(session.companyId, query);
    const { skip, take } = paginate(query.page, query.pageSize);
    const [rows, total] = await Promise.all([
      this.database.cashMovement.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
        select: cashMovementSelect,
      }),
      this.database.cashMovement.count({ where }),
    ]);
    return { items: rows.map(mapCashMovement), page: query.page, pageSize: query.pageSize, total };
  }

  async currentTotals(session: SessionContext) {
    const cashSession = await this.database.cashSession.findFirst({
      where: { companyId: session.companyId, status: "OPEN" },
      select: { id: true, openedAt: true, openingBalance: true },
    });
    if (!cashSession) return null;
    const asOf = new Date();
    const rows = await this.database.cashMovement.groupBy({
      by: ["paymentMethod"],
      where: {
        companyId: session.companyId,
        sessionId: cashSession.id,
        createdAt: { gte: cashSession.openedAt, lte: asOf },
      },
      _sum: { amount: true },
      _count: true,
    });
    const totals = calculateCashTotals(
      cashSession.openingBalance,
      rows.map((row) => ({
        paymentMethod: row.paymentMethod,
        amount: row._sum.amount,
        count: row._count,
      })),
    );
    return {
      sessionId: cashSession.id,
      openedAt: toArgentinaIso(cashSession.openedAt),
      asOf: toArgentinaIso(asOf),
      openingBalanceCents: cashSession.openingBalance,
      ...totals,
    };
  }
}
