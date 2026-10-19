import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import {
  argentinaDayEndExclusive,
  argentinaDayStart,
  todayInArgentina,
} from "../common/argentina-time.js";
import { accountSafeInteger } from "../customer-account/customer-account.service.js";
import type { SessionContext } from "../common/request-context.js";
import { DatabaseService } from "../database/database.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { mapDashboardActivityRow, type DashboardActivityRow } from "./dashboard.mapper.js";
import type { DashboardActivityQuery, DashboardSummary } from "./dashboard.schemas.js";
import { dashboardActivityResponseSchema, dashboardSummarySchema } from "./dashboard.schemas.js";

type SummaryRow = {
  salesTotal: bigint;
  salesCount: bigint;
  previousDayTotal: bigint;
  collectionsTotal: bigint;
  collectionsCount: bigint;
  receivablesBalance: bigint;
  customersWithBalance: bigint;
};

type DashboardDayRanges = {
  date: string;
  todayStart: Date;
  todayEnd: Date;
  previousDayStart: Date;
  previousDayEnd: Date;
};

export function dashboardDayRanges(now: Date): DashboardDayRanges {
  const date = todayInArgentina(now);
  const utcDate = new Date(`${date}T00:00:00.000Z`);
  utcDate.setUTCDate(utcDate.getUTCDate() - 1);
  const previousDate = utcDate.toISOString().slice(0, 10);
  return {
    date,
    todayStart: argentinaDayStart(date),
    todayEnd: argentinaDayEndExclusive(date),
    previousDayStart: argentinaDayStart(previousDate),
    previousDayEnd: argentinaDayEndExclusive(previousDate),
  };
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inventory: InventoryService,
  ) {}

  async summary(session: SessionContext): Promise<DashboardSummary> {
    const ranges = dashboardDayRanges(new Date());
    const [rows, inventory] = await Promise.all([
      this.database.$queryRaw<SummaryRow[]>(Prisma.sql`
        WITH sales_today AS (
          SELECT COALESCE(SUM(total_cents::bigint), 0)::bigint AS total,
            COUNT(*)::bigint AS count
          FROM documents
          WHERE company_id = ${session.companyId} AND status <> 'CANCELLED'
            AND created_at >= ${ranges.todayStart} AND created_at < ${ranges.todayEnd}
        ), sales_previous_day AS (
          SELECT COALESCE(SUM(total_cents::bigint), 0)::bigint AS total
          FROM documents
          WHERE company_id = ${session.companyId} AND status <> 'CANCELLED'
            AND created_at >= ${ranges.previousDayStart} AND created_at < ${ranges.previousDayEnd}
        ), collections_today AS (
          SELECT COALESCE(SUM(amount::bigint), 0)::bigint AS total,
            COUNT(*)::bigint AS count
          FROM cash_movements
          WHERE company_id = ${session.companyId}
            AND created_at >= ${ranges.todayStart} AND created_at < ${ranges.todayEnd}
        ), document_balances AS (
          SELECT customer_id, SUM(total_cents::bigint)::bigint AS amount
          FROM documents
          WHERE company_id = ${session.companyId} AND status <> 'CANCELLED'
          GROUP BY customer_id
        ), collection_balances AS (
          SELECT customer_id, SUM(amount::bigint)::bigint AS amount
          FROM cash_movements
          WHERE company_id = ${session.companyId}
          GROUP BY customer_id
        ), customer_balances AS (
          SELECT c.id,
            (COALESCE(d.amount, 0)::bigint - COALESCE(m.amount, 0)::bigint)::bigint AS balance
          FROM customers c
          LEFT JOIN document_balances d ON d.customer_id = c.id
          LEFT JOIN collection_balances m ON m.customer_id = c.id
          WHERE c.company_id = ${session.companyId}
        ), receivables AS (
          SELECT COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0)::bigint AS balance,
            COUNT(*) FILTER (WHERE balance > 0)::bigint AS customers_with_balance
          FROM customer_balances
        )
        SELECT sales_today.total AS "salesTotal", sales_today.count AS "salesCount",
          sales_previous_day.total AS "previousDayTotal",
          collections_today.total AS "collectionsTotal", collections_today.count AS "collectionsCount",
          receivables.balance AS "receivablesBalance",
          receivables.customers_with_balance AS "customersWithBalance"
        FROM sales_today CROSS JOIN sales_previous_day CROSS JOIN collections_today CROSS JOIN receivables
      `),
      this.inventory.summary(session),
    ]);
    const row = rows[0];
    if (!row) throw new Error("La consulta de resumen no devolvió una fila.");
    return dashboardSummarySchema.parse({
      date: ranges.date,
      salesToday: {
        totalCents: accountSafeInteger(row.salesTotal),
        count: accountSafeInteger(row.salesCount),
        previousDayTotalCents: accountSafeInteger(row.previousDayTotal),
      },
      collectionsToday: {
        totalCents: accountSafeInteger(row.collectionsTotal),
        count: accountSafeInteger(row.collectionsCount),
      },
      receivables: {
        balanceCents: accountSafeInteger(row.receivablesBalance),
        customersWithBalance: accountSafeInteger(row.customersWithBalance),
      },
      lowStockCount: inventory.lowStockCount,
    });
  }

  async activity(session: SessionContext, query: DashboardActivityQuery) {
    const rows = await this.database.$queryRaw<DashboardActivityRow[]>(Prisma.sql`
      SELECT kind, id, occurred_at AS "occurredAt", reference, counterparty,
        amount_cents AS "amountCents", quantity, status, ref_id AS "refId"
      FROM (
        (SELECT 'document'::text AS kind, d.id::text AS id, d.created_at AS occurred_at,
          d.internal_number::text AS reference, d.customer_name::text AS counterparty,
          d.total_cents::bigint AS amount_cents, NULL::bigint AS quantity,
          d.status::text AS status, d.id::text AS ref_id
        FROM documents d
        WHERE d.company_id = ${session.companyId}
        ORDER BY d.created_at DESC, d.id DESC LIMIT ${query.limit})
        UNION ALL
        (SELECT 'collection'::text, m.id::text, m.created_at,
          m.receipt_number::text, m.customer_name::text,
          m.amount::bigint, NULL::bigint, 'COLLECTED'::text, m.id::text
        FROM cash_movements m
        WHERE m.company_id = ${session.companyId}
        ORDER BY m.created_at DESC, m.id DESC LIMIT ${query.limit})
        UNION ALL
        (SELECT 'stock_movement'::text, sm.id::text, sm.created_at,
          sm.reference::text, p.name::text,
          NULL::bigint, sm.quantity::bigint, sm.type::text, sm.product_id::text
        FROM stock_movements sm
        INNER JOIN products p ON p.id = sm.product_id AND p.company_id = sm.company_id
        WHERE sm.company_id = ${session.companyId}
        ORDER BY sm.created_at DESC, sm.id DESC LIMIT ${query.limit})
      ) AS activity
      ORDER BY occurred_at DESC, id DESC, kind ASC
      LIMIT ${query.limit}
    `);
    return dashboardActivityResponseSchema.parse({ items: rows.map(mapDashboardActivityRow) });
  }
}
