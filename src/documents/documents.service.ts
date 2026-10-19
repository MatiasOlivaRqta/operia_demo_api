import { messageKey } from "../common/i18n/index.js";
import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { ApiException } from "../common/errors.js";
import type { MessageKey, MessageParams } from "../common/i18n/index.js";
import { calculateDocumentTotal } from "../common/money.js";
import { normalizeSearch } from "../common/search.js";
import { paginate, type Page } from "../common/pagination.js";
import type { SessionContext } from "../common/request-context.js";
import { DatabaseService } from "../database/database.service.js";
import { CustomerAccountService } from "../customer-account/customer-account.service.js";
import {
  documentDetailSelect,
  documentSummarySelect,
  mapDocument,
  mapDocumentSummary,
  type DocumentDto,
  type DocumentSummaryDto,
  mapDocumentCollections,
  type DocumentCollectionsDto,
  type DocumentCollectionRow,
} from "./document.mapper.js";
import type { CancellationInput, CreateDocumentInput, DocumentQuery } from "./document.schemas.js";

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestFingerprint(input: CreateDocumentInput): string {
  const canonicalPayload = canonicalize({ customerId: input.customerId, items: input.items });
  return createHash("sha256").update(canonicalPayload).digest("hex");
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly customerAccount: CustomerAccountService,
  ) {}

  async list(session: SessionContext, query: DocumentQuery): Promise<Page<DocumentSummaryDto>> {
    const term = normalizeSearch(query.search ?? "");
    const escapedTerm = term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const where: Prisma.DocumentWhereInput = {
      companyId: session.companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(term ? { searchText: { contains: escapedTerm } } : {}),
    };
    const { skip, take } = paginate(query.page, query.pageSize);
    const [rows, total] = await Promise.all([
      this.database.document.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
        select: documentSummarySelect,
      }),
      this.database.document.count({ where }),
    ]);
    return {
      items: rows.map(mapDocumentSummary),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async get(session: SessionContext, id: string): Promise<DocumentDto> {
    const row = await this.database.document.findUnique({
      where: { id_companyId: { id, companyId: session.companyId } },
      select: documentDetailSelect,
    });
    if (!row) throw this.notFound();
    if (row.status === "COMPLETED" || row.status === "CANCELLED") return mapDocument(row, 0);

    const paid = await this.database.accountEntry.aggregate({
      where: {
        companyId: session.companyId,
        documentId: id,
        type: { in: ["PAYMENT_APPLIED", "CREDIT_APPLIED"] },
      },
      _sum: { amount: true },
    });
    const paidCents = paid._sum.amount ?? 0;
    const pendingCents = Math.max(0, row.totalCents - paidCents);
    if (!Number.isSafeInteger(pendingCents))
      throw new RangeError("Pendiente fuera del rango seguro.");
    return mapDocument(row, pendingCents);
  }

  async collections(session: SessionContext, id: string): Promise<DocumentCollectionsDto> {
    const balance = await this.customerAccount.getDocumentBalance(session.companyId, id);
    if (!balance) throw this.notFound();
    if (balance.status === "CANCELLED")
      return mapDocumentCollections([], {
        totalCents: balance.totalCents,
        paidCents: 0,
        pendingCents: 0,
      });

    const rows = (await this.database.accountEntry.findMany({
      where: {
        companyId: session.companyId,
        documentId: id,
        type: { in: ["PAYMENT_APPLIED", "CREDIT_APPLIED"] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        type: true,
        amount: true,
        createdAt: true,
        cashMovement: {
          select: { id: true, createdAt: true, paymentMethod: true, receiptNumber: true },
        },
      },
    })) as DocumentCollectionRow[];
    return mapDocumentCollections(rows, balance);
  }

  async create(
    session: SessionContext,
    input: CreateDocumentInput,
    key: string | undefined,
  ): Promise<{ document: DocumentDto; replayed: boolean }> {
    if (typeof key !== "string" || key.length < 8 || key.length > 100) {
      throw new ApiException("validation", messageKey("validation.reviewInput"), 400, {
        "Idempotency-Key": ["customer.idempotency.length"],
      });
    }
    const fingerprint = requestFingerprint(input);
    const existing = await this.findByKey(session.companyId, key);
    if (existing) return { document: this.resolveReplay(existing, fingerprint), replayed: true };

    try {
      const document = await this.database.$transaction(
        async (tx) => {
          const customer = await tx.customer.findFirst({
            where: { id: input.customerId, companyId: session.companyId, status: "ACTIVE" },
            select: { id: true, commercialName: true },
          });
          if (!customer) throw this.businessRule("document.customer.inactive");

          const quantities = new Map<string, number>();
          for (const item of input.items)
            quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
          const productIds = [...quantities.keys()];
          const products = await tx.product.findMany({
            where: { companyId: session.companyId, id: { in: productIds } },
            select: { id: true, name: true, sku: true, status: true, stockOnHand: true },
          });
          const productById = new Map(products.map((product) => [product.id, product]));
          if (productIds.some((id) => productById.get(id)?.status !== "ACTIVE")) {
            throw this.businessRule("document.product.foreign");
          }
          for (const productId of productIds) {
            const product = productById.get(productId)!;
            if (product.stockOnHand < quantities.get(productId)!) {
              throw this.businessRule("document.stock.insufficient", { product: product.name });
            }
          }

          for (const productId of productIds.sort((left, right) => left.localeCompare(right))) {
            const product = productById.get(productId)!;
            const changed = await tx.product.updateMany({
              where: {
                id: productId,
                companyId: session.companyId,
                status: "ACTIVE",
                stockOnHand: { gte: quantities.get(productId)! },
              },
              data: { stockOnHand: { decrement: quantities.get(productId)! } },
            });
            if (!changed.count)
              throw this.businessRule("document.stock.insufficient", { product: product.name });
          }

          const counter = await tx.$queryRaw<Array<{ last_number: number }>>`
            INSERT INTO document_counters (company_id, last_number)
            VALUES (${session.companyId}, 1)
            ON CONFLICT (company_id)
            DO UPDATE SET last_number = document_counters.last_number + 1
            RETURNING last_number
          `;
          const internalNumber = `0001-${String(counter[0]!.last_number).padStart(8, "0")}`;
          const id = `pv-${internalNumber}`;
          const totalCents = calculateDocumentTotal(input.items);
          const items = input.items.map((item, position) => {
            const product = productById.get(item.productId)!;
            return {
              position,
              productId: product.id,
              productName: product.name,
              sku: product.sku,
              quantity: item.quantity,
              unitPriceCents: item.unitPriceCents,
              discountRate: new Prisma.Decimal(item.discountRate),
              taxRate: new Prisma.Decimal(item.taxRate),
            };
          });
          await tx.document.create({
            data: {
              id,
              companyId: session.companyId,
              customerId: customer.id,
              customerName: customer.commercialName,
              internalNumber,
              pointOfSale: "0001",
              status: "PENDING",
              totalCents,
              idempotencyKey: key,
              requestFingerprint: fingerprint,
              searchText: normalizeSearch(`${internalNumber} ${customer.commercialName}`),
              items: { create: items },
            },
          });
          for (const [productId, quantity] of [...quantities.entries()].sort(([a], [b]) =>
            a.localeCompare(b),
          )) {
            await tx.stockMovement.create({
              data: {
                companyId: session.companyId,
                productId,
                type: "SALIDA",
                quantity: -quantity,
                reference: internalNumber,
                note: `Comprobante ${internalNumber}`,
                documentId: id,
              },
            });
          }
          const row = await tx.document.findUnique({
            where: { id_companyId: { id, companyId: session.companyId } },
            select: documentDetailSelect,
          });
          if (!row) throw new Error("No se pudo leer el comprobante recién creado.");
          return mapDocument(row);
        },
        { timeout: 10_000, maxWait: 5_000 },
      );
      return { document, replayed: false };
    } catch (error: unknown) {
      if (!this.isUniqueViolation(error)) throw error;
      const raced = await this.findByKey(session.companyId, key);
      if (!raced) throw error;
      return { document: this.resolveReplay(raced, fingerprint), replayed: true };
    }
  }

  async cancel(
    session: SessionContext,
    id: string,
    input: CancellationInput,
  ): Promise<DocumentDto> {
    return this.database.$transaction(async (tx) => {
      const document = await tx.document.findUnique({
        where: { id_companyId: { id, companyId: session.companyId } },
        select: { id: true, status: true, internalNumber: true, customerId: true },
      });
      if (!document) throw this.notFound();
      if (document.status === "CANCELLED")
        throw new ApiException("conflict", messageKey("document.cancelled"), 409);

      await this.customerAccount.lockCustomer(tx, session.companyId, document.customerId);
      if (await this.customerAccount.hasImputations(session.companyId, id, tx))
        throw new ApiException("conflict", messageKey("document.hasPayments"), 409);

      const changed = await tx.document.updateMany({
        where: { id, companyId: session.companyId, status: "PENDING" },
        data: { status: "CANCELLED", cancellationReason: input.reason, cancelledAt: new Date() },
      });
      if (!changed.count) throw new ApiException("conflict", messageKey("document.cancelled"), 409);

      const outgoing = await tx.stockMovement.findMany({
        where: { companyId: session.companyId, documentId: id, type: "SALIDA" },
        orderBy: { productId: "asc" },
        select: { id: true, productId: true, quantity: true },
      });
      const reversals = outgoing.length
        ? await tx.stockMovement.findMany({
            where: {
              companyId: session.companyId,
              reversesMovementId: { in: outgoing.map((movement) => movement.id) },
            },
            select: { reversesMovementId: true },
          })
        : [];
      const reversedIds = new Set(
        reversals.flatMap((movement) => movement.reversesMovementId ?? []),
      );
      for (const movement of outgoing) {
        if (reversedIds.has(movement.id)) continue;
        await tx.product.update({
          where: { id_companyId: { id: movement.productId, companyId: session.companyId } },
          data: { stockOnHand: { increment: -movement.quantity } },
        });
        await tx.stockMovement.create({
          data: {
            companyId: session.companyId,
            productId: movement.productId,
            type: "REVERSION",
            quantity: -movement.quantity,
            reversesMovementId: movement.id,
            reference: document.internalNumber,
            note: `Anulación ${document.internalNumber}`,
            documentId: id,
          },
        });
      }
      const row = await tx.document.findUnique({
        where: { id_companyId: { id, companyId: session.companyId } },
        select: documentDetailSelect,
      });
      if (!row) throw this.notFound();
      return mapDocument(row);
    });
  }

  private async findByKey(companyId: string, idempotencyKey: string) {
    return this.database.document.findUnique({
      where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
      select: documentDetailSelect,
    });
  }

  private resolveReplay(
    row: NonNullable<Awaited<ReturnType<DocumentsService["findByKey"]>>>,
    fingerprint: string,
  ): DocumentDto {
    if (row.requestFingerprint !== fingerprint)
      throw new ApiException("conflict", messageKey("cash.idempotency.conflict"), 409);
    return mapDocument(row);
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
  private notFound(): ApiException {
    return new ApiException("not_found", messageKey("cash.document.notFound"), 404);
  }
  private businessRule(message: MessageKey, params: MessageParams = {}): ApiException {
    return new ApiException("business_rule", message, 422, undefined, params);
  }
}
