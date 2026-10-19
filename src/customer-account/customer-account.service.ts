import { messageKey } from "../common/i18n/index.js";
import { Injectable } from "@nestjs/common";
import { Prisma, type AccountEntry } from "../generated/prisma/client.js";
import { DatabaseService } from "../database/database.service.js";
import { ApiException } from "../common/errors.js";
import { paginate, type Page } from "../common/pagination.js";
import type {
  AccountQuery,
  AccountApplicationInput,
  AccountMovementsQuery,
  AccountMovementKind,
} from "./customer-account.schemas.js";
import {
  decodeAccountMovementCursor,
  encodeAccountMovementCursor,
} from "./customer-account.schemas.js";
import {
  mapCustomerAccount,
  mapApplication,
  mapAccountMovements,
  mapCollectionApplications,
} from "./customer-account.mapper.js";
import type { AccountMovement } from "./customer-account.mapper.js";
import { settlementStatus } from "../cash/settlement-status.js";

export function accountSafeInteger(value: bigint | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError("Importe fuera del rango seguro.");
  return result;
}
export type PendingDocument = {
  id: string;
  internalNumber: string;
  createdAt: Date;
  totalCents: number;
  paidCents: number;
  pendingCents: number;
};
type PendingRow = Omit<PendingDocument, "paidCents" | "pendingCents"> & {
  paidCents: bigint;
  pendingCents: bigint;
};
type AccountMovementRow = {
  id: string;
  kind: AccountMovementKind;
  kindOrder: number;
  occurredAt: Date;
  reference: string;
  documentNumber: string | null;
  debitCents: bigint;
  creditCents: bigint;
  appliedCents: bigint | null;
  impact: bigint;
  impactBefore: bigint;
  netBalance: bigint;
  documentId: string | null;
  cashMovementId: string | null;
};
export type DocumentBalance = PendingDocument & {
  customerId: string;
  status: "PENDING" | "PARTIAL" | "COMPLETED" | "CANCELLED";
};
export type AccountTotals = { debtCents: number; creditCents: number };
export type AccountSummary = {
  customerId: string;
  invoicedCents: number;
  collectedCents: number;
  netBalanceCents: number;
};
export function validateCreditApplication(
  customerId: string,
  document: DocumentBalance | null,
  creditCents: number,
  amountCents: number,
): asserts document is DocumentBalance {
  if (!document) throw new ApiException("not_found", messageKey("cash.document.notFound"), 404);
  if (
    document.customerId !== customerId ||
    (document.status !== "PENDING" && document.status !== "PARTIAL") ||
    document.pendingCents <= 0
  )
    throw new ApiException("business_rule", messageKey("account.document.notApplicable"), 422);
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 2_147_483_647)
    throw new ApiException("business_rule", messageKey("account.application.amountInvalid"), 422);
  if (amountCents > creditCents || amountCents > document.pendingCents)
    throw new ApiException("business_rule", messageKey("account.application.amountTooHigh"), 422, {
      amountCents: ["account.application.amountTooHigh"],
    });
}
export type EntryInput =
  | { type: "PAYMENT_APPLIED"; documentId: string; cashMovementId: string; amountCents: number }
  | { type: "CREDIT_GENERATED"; cashMovementId: string; amountCents: number }
  | { type: "CREDIT_APPLIED"; documentId: string; amountCents: number };

function pendingCte(companyId: string, customerId: string): Prisma.Sql {
  return Prisma.sql`
    WITH paid AS (
      SELECT document_id, SUM(amount)::bigint AS amount
      FROM account_entries
      WHERE company_id = ${companyId} AND customer_id = ${customerId} AND type IN ('P', 'A')
      GROUP BY document_id
    ), pending AS (
      SELECT d.id, d.internal_number, d.created_at, d.total_cents,
        COALESCE(p.amount, 0)::bigint AS paid,
        (d.total_cents::bigint - COALESCE(p.amount, 0))::bigint AS pending
      FROM documents d LEFT JOIN paid p ON p.document_id = d.id
      WHERE d.company_id = ${companyId} AND d.customer_id = ${customerId} AND d.status <> 'CANCELLED'
    )
  `;
}
const pendingColumns = Prisma.sql`id, internal_number AS "internalNumber", created_at AS "createdAt",
  total_cents AS "totalCents", paid AS "paidCents", pending AS "pendingCents"`;
function mapPending(row: PendingRow): PendingDocument {
  const result = {
    ...row,
    paidCents: accountSafeInteger(row.paidCents),
    pendingCents: accountSafeInteger(row.pendingCents),
  };
  if (result.pendingCents < 0) throw new RangeError("Pendiente negativo.");
  return result;
}

@Injectable()
export class CustomerAccountService {
  constructor(private readonly database: DatabaseService) {}

  async applyCredit(companyId: string, customerId: string, input: AccountApplicationInput) {
    return this.database.$transaction(async (tx) => {
      await this.lockCustomer(tx, companyId, customerId);
      const document = await this.getDocumentBalance(companyId, input.documentId, tx);
      const { creditCents } = await this.getTotals(companyId, customerId, tx);
      validateCreditApplication(customerId, document, creditCents, input.amountCents);
      const entries = await this.recordEntries(tx, companyId, customerId, [
        { type: "CREDIT_APPLIED", documentId: document.id, amountCents: input.amountCents },
      ]);
      await this.updateSettlementStatuses(tx, companyId, customerId, [document.id]);
      return {
        application: mapApplication(entries[0]!),
        document: { id: document.id, pendingCents: document.pendingCents - input.amountCents },
        creditCents: creditCents - input.amountCents,
      };
    });
  }

  async getAccount(companyId: string, customerId: string, query: AccountQuery) {
    return this.database.$transaction(
      async (tx) => {
        const customer = await tx.customer.findUnique({
          where: { id_companyId: { id: customerId, companyId } },
          select: { id: true },
        });
        if (!customer) throw new ApiException("not_found", messageKey("customer.notFound"), 404);
        const totals = await this.getTotals(companyId, customerId, tx);
        const pending = await this.listPending(
          companyId,
          customerId,
          query.page,
          query.pageSize,
          tx,
        );
        return mapCustomerAccount(customerId, totals, pending);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async getSummary(companyId: string, customerId: string): Promise<AccountSummary> {
    return this.database.$transaction(
      async (tx) => {
        await this.requireCustomer(tx, companyId, customerId);
        const rows = await tx.$queryRaw<{ invoiced: bigint; collected: bigint }[]>(Prisma.sql`
          SELECT
            COALESCE((SELECT SUM(total_cents::bigint) FROM documents
              WHERE company_id = ${companyId} AND customer_id = ${customerId} AND status <> 'CANCELLED'), 0)::bigint AS invoiced,
            COALESCE((SELECT SUM(amount::bigint) FROM cash_movements
              WHERE company_id = ${companyId} AND customer_id = ${customerId}), 0)::bigint AS collected
        `);
        const invoicedCents = accountSafeInteger(rows[0]!.invoiced);
        const collectedCents = accountSafeInteger(rows[0]!.collected);
        const netBalanceCents = accountSafeInteger(BigInt(invoicedCents) - BigInt(collectedCents));
        return { customerId, invoicedCents, collectedCents, netBalanceCents };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async listMovements(companyId: string, customerId: string, query: AccountMovementsQuery) {
    return this.database.$transaction(
      async (tx) => {
        await this.requireCustomer(tx, companyId, customerId);
        const cursor = query.cursor ? decodeAccountMovementCursor(query.cursor) : null;
        const cursorDate = cursor ? new Date(cursor.t) : null;
        const cursorKind = cursor?.k ?? null;
        const cursorId = cursor?.id ?? null;
        const rows = await tx.$queryRaw<AccountMovementRow[]>(Prisma.sql`
          WITH movements AS (
            SELECT ('doc:' || d.id)::text AS id, 'DOCUMENT'::text AS kind, 1::integer AS kind_order,
              d.created_at AS occurred_at, d.internal_number::text AS reference, NULL::text AS "documentNumber",
              d.id::text AS "documentId", NULL::text AS "cashMovementId",
              d.total_cents::bigint AS debit, 0::bigint AS credit, NULL::bigint AS applied,
              d.total_cents::bigint AS impact
            FROM documents d
            WHERE d.company_id = ${companyId} AND d.customer_id = ${customerId}
            UNION ALL
            SELECT ('can:' || d.id)::text, 'CANCELLATION'::text, 4::integer,
              d.cancelled_at, d.internal_number::text, NULL::text,
              d.id::text, NULL::text,
              0::bigint, d.total_cents::bigint, NULL::bigint, -d.total_cents::bigint
            FROM documents d
            WHERE d.company_id = ${companyId} AND d.customer_id = ${customerId}
              AND d.status = 'CANCELLED' AND d.cancelled_at IS NOT NULL
            UNION ALL
            SELECT ('col:' || cm.id)::text, 'COLLECTION'::text, 3::integer,
              cm.created_at, cm.receipt_number::text, cm.document_number::text,
              cm.document_id::text, cm.id::text,
              0::bigint, cm.amount::bigint, NULL::bigint, -cm.amount::bigint
            FROM cash_movements cm
            WHERE cm.company_id = ${companyId} AND cm.customer_id = ${customerId}
            UNION ALL
            SELECT ('app:' || e.id)::text, 'CREDIT_APPLIED'::text, 2::integer,
              e.created_at, d.internal_number::text, d.internal_number::text,
              e.document_id::text, NULL::text,
              0::bigint, 0::bigint, e.amount::bigint, 0::bigint
            FROM account_entries e
            LEFT JOIN documents d ON d.company_id = e.company_id AND d.id = e.document_id
            WHERE e.company_id = ${companyId} AND e.customer_id = ${customerId} AND e.type = 'A'
          ), totals AS (
            SELECT
              COALESCE((SELECT SUM(total_cents::bigint) FROM documents
                WHERE company_id = ${companyId} AND customer_id = ${customerId} AND status <> 'CANCELLED'), 0)::bigint
              - COALESCE((SELECT SUM(amount::bigint) FROM cash_movements
                WHERE company_id = ${companyId} AND customer_id = ${customerId}), 0)::bigint AS net_balance
          ), newer AS (
            SELECT COALESCE(SUM(impact), 0)::bigint AS impact_before
            FROM movements
            WHERE ${cursorDate}::timestamptz IS NOT NULL
              AND (occurred_at, kind_order, id) >= (${cursorDate}::timestamptz, ${cursorKind}::integer, ${cursorId}::text)
          )
          SELECT m.id, m.kind, m.kind_order AS "kindOrder", m.occurred_at AS "occurredAt",
            m.reference, m."documentNumber", m."documentId", m."cashMovementId",
            m.debit AS "debitCents", m.credit AS "creditCents",
            m.applied AS "appliedCents", m.impact, newer.impact_before AS "impactBefore",
            totals.net_balance AS "netBalance"
          FROM movements m CROSS JOIN totals CROSS JOIN newer
          WHERE ${cursorDate}::timestamptz IS NULL
            OR (m.occurred_at, m.kind_order, m.id) < (${cursorDate}::timestamptz, ${cursorKind}::integer, ${cursorId}::text)
          ORDER BY m.occurred_at DESC, m.kind_order DESC, m.id DESC
          LIMIT ${query.limit + 1}
        `);
        const hasMore = rows.length > query.limit;
        const selected = hasMore ? rows.slice(0, query.limit) : rows;
        const seedBalance = selected.length
          ? accountSafeInteger(selected[0]!.netBalance - selected[0]!.impactBefore)
          : 0;
        const mappedRows: AccountMovement[] = selected.map((row) => ({
          id: row.id,
          kind: row.kind,
          occurredAt: row.occurredAt,
          reference: row.reference,
          documentNumber: row.documentNumber,
          documentId: row.documentId,
          cashMovementId: row.cashMovementId,
          debitCents: accountSafeInteger(row.debitCents),
          creditCents: accountSafeInteger(row.creditCents),
          appliedCents: row.appliedCents === null ? null : accountSafeInteger(row.appliedCents),
        }));
        const items = mapAccountMovements(mappedRows, seedBalance);
        const last = selected.at(-1);
        const nextCursor =
          hasMore && last
            ? encodeAccountMovementCursor({
                t: last.occurredAt.toISOString(),
                k: last.kindOrder,
                id: last.id,
              })
            : null;
        return { items, nextCursor };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async getCollectionApplications(companyId: string, customerId: string, cashMovementId: string) {
    const movement = await this.database.cashMovement.findFirst({
      where: { id: cashMovementId, companyId, customerId, type: "COBRO" },
      select: { id: true, receiptNumber: true, paymentMethod: true, createdAt: true, amount: true },
    });
    if (!movement) throw new ApiException("not_found", messageKey("cash.document.notFound"), 404);

    const entries = await this.database.accountEntry.findMany({
      where: {
        companyId,
        customerId,
        cashMovementId,
        type: { in: ["PAYMENT_APPLIED", "CREDIT_GENERATED"] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        type: true,
        amount: true,
        document: { select: { id: true, internalNumber: true, status: true } },
      },
    });
    const documents = entries.flatMap((entry) =>
      entry.type === "PAYMENT_APPLIED" && entry.document
        ? [
            {
              documentId: entry.document.id,
              documentNumber: entry.document.internalNumber,
              amount: entry.amount,
              status: entry.document.status,
            },
          ]
        : [],
    );
    const creditGenerated = entries
      .filter((entry) => entry.type === "CREDIT_GENERATED")
      .reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
    return mapCollectionApplications(movement, documents, creditGenerated);
  }

  private async requireCustomer(
    tx: Prisma.TransactionClient,
    companyId: string,
    customerId: string,
  ): Promise<void> {
    const customer = await tx.customer.findUnique({
      where: { id_companyId: { id: customerId, companyId } },
      select: { id: true },
    });
    if (!customer) throw new ApiException("not_found", messageKey("customer.notFound"), 404);
  }

  async lockCustomer(
    tx: Prisma.TransactionClient,
    companyId: string,
    customerId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM customers WHERE company_id = ${companyId} AND id = ${customerId} FOR UPDATE
    `);
    if (rows.length === 0)
      throw new ApiException("not_found", messageKey("customer.notFound"), 404);
  }

  async getTotals(
    companyId: string,
    customerId: string,
    tx: Prisma.TransactionClient = this.database,
  ): Promise<AccountTotals> {
    const rows = await tx.$queryRaw<{ debt: bigint; credit: bigint }[]>(Prisma.sql`
      ${pendingCte(companyId, customerId)}
      SELECT COALESCE((SELECT SUM(pending) FROM pending), 0)::bigint AS debt,
        COALESCE((SELECT SUM(CASE WHEN type = 'G' THEN amount::bigint WHEN type = 'A' THEN -amount::bigint ELSE 0 END)
          FROM account_entries WHERE company_id = ${companyId} AND customer_id = ${customerId}), 0)::bigint AS credit
    `);
    const totals = {
      debtCents: accountSafeInteger(rows[0]!.debt),
      creditCents: accountSafeInteger(rows[0]!.credit),
    };
    if (totals.debtCents < 0 || totals.creditCents < 0)
      throw new RangeError("Saldo negativo inconsistente.");
    return totals;
  }

  async getDocumentBalance(
    companyId: string,
    documentId: string,
    tx: Prisma.TransactionClient = this.database,
  ): Promise<DocumentBalance | null> {
    const rows = await tx.$queryRaw<
      (PendingRow & Pick<DocumentBalance, "customerId" | "status">)[]
    >(Prisma.sql`
      SELECT d.id, d.internal_number AS "internalNumber", d.created_at AS "createdAt", d.total_cents AS "totalCents",
        d.customer_id AS "customerId", d.status,
        COALESCE(SUM(e.amount), 0)::bigint AS "paidCents",
        (CASE WHEN d.status <> 'CANCELLED' THEN d.total_cents::bigint - COALESCE(SUM(e.amount), 0) ELSE 0 END)::bigint AS "pendingCents"
      FROM documents d LEFT JOIN account_entries e
        ON e.company_id = d.company_id AND e.document_id = d.id AND e.type IN ('P', 'A')
      WHERE d.company_id = ${companyId} AND d.id = ${documentId}
      GROUP BY d.company_id, d.id
    `);
    const row = rows[0];
    return row ? { ...mapPending(row), customerId: row.customerId, status: row.status } : null;
  }

  async listPending(
    companyId: string,
    customerId: string,
    page: number,
    pageSize: number,
    tx: Prisma.TransactionClient = this.database,
  ): Promise<Page<PendingDocument>> {
    const { skip, take } = paginate(page, pageSize);
    const rows = await tx.$queryRaw<PendingRow[]>(Prisma.sql`
      ${pendingCte(companyId, customerId)} SELECT ${pendingColumns} FROM pending
      WHERE pending > 0 ORDER BY created_at, id LIMIT ${take} OFFSET ${skip}
    `);
    const counts = await tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      ${pendingCte(companyId, customerId)} SELECT COUNT(*)::bigint AS total FROM pending WHERE pending > 0
    `);
    return {
      items: rows.map(mapPending),
      page,
      pageSize,
      total: accountSafeInteger(counts[0]!.total),
    };
  }

  async pendingForAmount(
    tx: Prisma.TransactionClient,
    companyId: string,
    customerId: string,
    amountCents: number,
  ): Promise<PendingDocument[]> {
    if (!Number.isSafeInteger(amountCents) || amountCents < 1)
      throw new RangeError("Importe inválido.");
    const rows = await tx.$queryRaw<PendingRow[]>(Prisma.sql`
      ${pendingCte(companyId, customerId)}, running AS (
        SELECT *, SUM(pending) OVER (ORDER BY created_at, id ROWS UNBOUNDED PRECEDING) AS cumulative
        FROM pending WHERE pending > 0
      ) SELECT ${pendingColumns} FROM running
      WHERE cumulative - pending < ${amountCents} ORDER BY created_at, id
    `);
    return rows.map(mapPending);
  }

  async hasImputations(
    companyId: string,
    documentId: string,
    tx: Prisma.TransactionClient = this.database,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ exists: boolean }[]>(Prisma.sql`
      SELECT EXISTS(SELECT 1 FROM account_entries WHERE company_id = ${companyId} AND document_id = ${documentId}) AS exists
    `);
    return rows[0]!.exists;
  }

  async recordEntries(
    tx: Prisma.TransactionClient,
    companyId: string,
    customerId: string,
    entries: readonly EntryInput[],
  ): Promise<AccountEntry[]> {
    const result: AccountEntry[] = [];
    for (const entry of entries) {
      if (
        !Number.isSafeInteger(entry.amountCents) ||
        entry.amountCents < 1 ||
        entry.amountCents > 2_147_483_647
      )
        throw new RangeError("Importe de imputación inválido.");
      result.push(
        await tx.accountEntry.create({
          data: {
            companyId,
            customerId,
            type: entry.type,
            amount: entry.amountCents,
            documentId: "documentId" in entry ? entry.documentId : null,
            cashMovementId: "cashMovementId" in entry ? entry.cashMovementId : null,
          },
        }),
      );
    }
    return result;
  }

  async updateSettlementStatuses(
    tx: Prisma.TransactionClient,
    companyId: string,
    customerId: string,
    documentIds: readonly string[],
  ): Promise<void> {
    const ids = [...new Set(documentIds)];
    if (ids.length === 0) return;
    const rows = await tx.$queryRaw<
      { id: string; totalCents: bigint; paidCents: bigint; status: DocumentBalance["status"] }[]
    >(Prisma.sql`
      SELECT d.id, d.total_cents::bigint AS "totalCents", d.status,
        COALESCE(SUM(e.amount), 0)::bigint AS "paidCents"
      FROM documents d LEFT JOIN account_entries e
        ON e.company_id = d.company_id AND e.document_id = d.id AND e.type IN ('P', 'A')
      WHERE d.company_id = ${companyId} AND d.customer_id = ${customerId}
        AND d.id IN (${Prisma.join(ids)})
      GROUP BY d.company_id, d.id
    `);
    for (const row of rows) {
      if (row.status === "CANCELLED") continue;
      const status = settlementStatus(
        accountSafeInteger(row.totalCents),
        accountSafeInteger(row.paidCents),
      );
      if (status === row.status) continue;
      await tx.document.updateMany({
        where: { id: row.id, companyId, customerId, status: row.status },
        data: { status },
      });
    }
  }
}
