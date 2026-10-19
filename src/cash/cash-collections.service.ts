import { messageKey } from "../common/i18n/index.js";
import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { ApiException } from "../common/errors.js";
import type { SessionContext } from "../common/request-context.js";
import { DatabaseService } from "../database/database.service.js";
import {
  CustomerAccountService,
  type DocumentBalance,
  type EntryInput,
} from "../customer-account/customer-account.service.js";
import { allocate } from "./cash.allocation.js";
import {
  cashReceiptSelect,
  mapCashReceipt,
  type CashReceiptDto,
  type CashReceiptRow,
} from "./cash-collections.mapper.js";
import { validateCollectionKey, type CashCollectionInput } from "./cash-collections.schemas.js";

export function collectionFingerprint(sessionId: string, input: CashCollectionInput): string {
  // Fixed alphabetical order; optional documentId is always represented as null.
  const canonical = JSON.stringify({
    amountCents: input.amountCents,
    customerId: input.customerId,
    documentId: input.documentId ?? null,
    paymentMethod: input.paymentMethod,
    sessionId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function validateCollectionDocument(
  customerId: string,
  document: DocumentBalance | null,
): asserts document is DocumentBalance {
  if (!document) throw new ApiException("not_found", messageKey("cash.document.notFound"), 404);
  if (
    document.customerId !== customerId ||
    (document.status !== "PENDING" && document.status !== "PARTIAL") ||
    document.pendingCents <= 0
  )
    throw new ApiException("business_rule", messageKey("cash.document.notCollectible"), 422);
}

export function validateLockedCollectionDocument(
  customerId: string,
  document: DocumentBalance | null,
): asserts document is DocumentBalance {
  if (!document) throw new ApiException("not_found", messageKey("cash.document.notFound"), 404);
  if (document.customerId !== customerId || document.status === "CANCELLED")
    throw new ApiException("business_rule", messageKey("cash.document.notCollectible"), 422);
}

type CollectionResult = { receipt: CashReceiptDto; replayed: boolean };

@Injectable()
export class CashCollectionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly customerAccount: CustomerAccountService,
  ) {}

  async collect(
    session: SessionContext,
    sessionId: string,
    input: CashCollectionInput,
    headerKey: string | undefined,
  ): Promise<CollectionResult> {
    const key = validateCollectionKey(headerKey);
    const fingerprint = collectionFingerprint(sessionId, input);
    const existing = await this.findByKey(this.database, session.companyId, key);
    if (existing) return this.replay(this.database, session.companyId, existing, fingerprint);

    try {
      return await this.database.$transaction(
        async (tx): Promise<CollectionResult> => {
          const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT id FROM cash_sessions WHERE id = ${sessionId} AND company_id = ${session.companyId} FOR SHARE
        `);
          if (!locked.length)
            throw new ApiException("not_found", messageKey("cash.session.notFound"), 404);
          const cashSession = await tx.cashSession.findUniqueOrThrow({
            where: { id_companyId: { id: sessionId, companyId: session.companyId } },
            select: { status: true },
          });
          const committed = await this.findByKey(tx, session.companyId, key);
          if (committed) return this.replay(tx, session.companyId, committed, fingerprint);
          if (cashSession.status === "CLOSED")
            throw new ApiException("conflict", messageKey("cash.session.closed"), 409);

          if (input.documentId) {
            const admissionDocument = await this.customerAccount.getDocumentBalance(
              session.companyId,
              input.documentId,
              tx,
            );
            validateCollectionDocument(input.customerId, admissionDocument);
          }

          await this.customerAccount.lockCustomer(tx, session.companyId, input.customerId);
          const replayed = await this.findByKey(tx, session.companyId, key);
          if (replayed) return this.replay(tx, session.companyId, replayed, fingerprint);
          const customer = await tx.customer.findUniqueOrThrow({
            where: { id_companyId: { id: input.customerId, companyId: session.companyId } },
            select: { commercialName: true },
          });
          let documentNumber: string | null = null;
          let pendingDocs: { documentId: string; pending: number }[];
          if (input.documentId) {
            const document = await this.customerAccount.getDocumentBalance(
              session.companyId,
              input.documentId,
              tx,
            );
            validateLockedCollectionDocument(input.customerId, document);
            documentNumber = document.internalNumber;
            pendingDocs = [{ documentId: document.id, pending: document.pendingCents }];
          } else {
            const pending = await this.customerAccount.pendingForAmount(
              tx,
              session.companyId,
              input.customerId,
              input.amountCents,
            );
            pendingDocs = pending.map((row) => ({ documentId: row.id, pending: row.pendingCents }));
          }
          const allocation = allocate(input.amountCents, pendingDocs, input.documentId);

          const counters = await tx.$queryRaw<{ last_number: number }[]>(Prisma.sql`
          INSERT INTO receipt_counters (company_id, last_number) VALUES (${session.companyId}, 1)
          ON CONFLICT (company_id) DO UPDATE SET last_number = receipt_counters.last_number + 1
          RETURNING last_number
        `);
          const receiptNumber = `R-0001-${String(counters[0]!.last_number).padStart(8, "0")}`;
          const movement = await tx.cashMovement.create({
            data: {
              companyId: session.companyId,
              sessionId,
              type: "COBRO",
              customerId: input.customerId,
              customerName: customer.commercialName,
              documentId: input.documentId ?? null,
              documentNumber,
              paymentMethod: input.paymentMethod,
              amount: input.amountCents,
              receiptNumber,
              idempotencyKey: key,
              requestFingerprint: fingerprint,
            },
            select: { id: true },
          });
          const entries: EntryInput[] = allocation.applications.map((application) => ({
            type: "PAYMENT_APPLIED",
            documentId: application.documentId,
            cashMovementId: movement.id,
            amountCents: application.amount,
          }));
          if (allocation.creditGenerated > 0)
            entries.push({
              type: "CREDIT_GENERATED",
              cashMovementId: movement.id,
              amountCents: allocation.creditGenerated,
            });
          await this.customerAccount.recordEntries(
            tx,
            session.companyId,
            input.customerId,
            entries,
          );
          await this.customerAccount.updateSettlementStatuses(
            tx,
            session.companyId,
            input.customerId,
            [...new Set(allocation.applications.map((application) => application.documentId))],
          );
          const row = await tx.cashMovement.findUniqueOrThrow({
            where: { id_companyId: { id: movement.id, companyId: session.companyId } },
            select: cashReceiptSelect,
          });
          const totals = await this.customerAccount.getTotals(
            session.companyId,
            input.customerId,
            tx,
          );
          return { receipt: mapCashReceipt(row, totals.creditCents), replayed: false };
        },
        { timeout: 10_000 },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const row = await this.findByKey(this.database, session.companyId, key);
        if (row) return this.replay(this.database, session.companyId, row, fingerprint);
      }
      throw error;
    }
  }

  private findByKey(tx: Prisma.TransactionClient, companyId: string, idempotencyKey: string) {
    return tx.cashMovement.findUnique({
      where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
      select: cashReceiptSelect,
    });
  }

  private async replay(
    tx: Prisma.TransactionClient,
    companyId: string,
    row: CashReceiptRow,
    fingerprint: string,
  ): Promise<CollectionResult> {
    if (row.requestFingerprint !== fingerprint)
      throw new ApiException("conflict", messageKey("cash.idempotency.conflict"), 409);
    const totals = await this.customerAccount.getTotals(companyId, row.customerId, tx);
    return { receipt: mapCashReceipt(row, totals.creditCents), replayed: true };
  }
}
