import { messageKey } from "../common/i18n/index.js";
import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { ApiException } from "../common/errors.js";
import type { MessageKey } from "../common/i18n/index.js";
import { argentinaDayEndExclusive, argentinaDayStart } from "../common/argentina-time.js";
import { paginate, type Page } from "../common/pagination.js";
import { buildProductIndexFields, normalizeSearch } from "../common/search.js";
import type { SessionContext } from "../common/request-context.js";
import { DatabaseService } from "../database/database.service.js";
import type { ProductDto, StockMovementDto } from "./product.mapper.js";
import { mapMovementToDto, mapProductInput, mapProductToDto } from "./product.mapper.js";
import type {
  ProductInput,
  ProductQuery,
  ReversalInput,
  StockAdjustmentInput,
  StockMovementInput,
  ProductMovementQuery,
} from "./product.schemas.js";
import { decodeProductMovementCursor, encodeProductMovementCursor } from "./product.schemas.js";

const productSelect = {
  id: true,
  companyId: true,
  sku: true,
  barcode: true,
  name: true,
  categoryId: true,
  category: { select: { description: true } },
  unit: true,
  costCents: true,
  priceCents: true,
  minimumStock: true,
  stockOnHand: true,
  status: true,
} as const;
const movementSelect = {
  id: true,
  companyId: true,
  productId: true,
  type: true,
  quantity: true,
  reference: true,
  note: true,
  documentId: true,
  reversesMovementId: true,
  createdAt: true,
  product: { select: { name: true, sku: true } },
} as const;

@Injectable()
export class ProductsService {
  constructor(private readonly database: DatabaseService) {}

  async list(session: SessionContext, query: ProductQuery): Promise<Page<ProductDto>> {
    const term = normalizeSearch(query.search ?? "");
    const escapedTerm = term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const where: Prisma.ProductWhereInput = {
      companyId: session.companyId,
      ...(query.status ? { status: query.status === "active" ? "ACTIVE" : "INACTIVE" } : {}),
      ...(term ? { searchText: { contains: escapedTerm } } : {}),
      ...(query.lowStock
        ? { stockOnHand: { lte: this.database.product.fields.minimumStock } }
        : {}),
    };
    const { skip, take } = paginate(query.page, query.pageSize);
    const [rows, total] = await Promise.all([
      this.database.product.findMany({
        where,
        orderBy: [{ nameNormalized: "asc" }, { id: "asc" }],
        skip,
        take,
        select: productSelect,
      }),
      this.database.product.count({ where }),
    ]);
    return { items: rows.map(mapProductToDto), page: query.page, pageSize: query.pageSize, total };
  }

  async get(session: SessionContext, id: string): Promise<ProductDto> {
    const row = await this.database.product.findUnique({
      where: { id_companyId: { id, companyId: session.companyId } },
      select: productSelect,
    });
    if (!row) throw this.notFound();
    return mapProductToDto(row);
  }

  async create(session: SessionContext, input: ProductInput): Promise<ProductDto> {
    try {
      const row = await this.database.product.create({
        data: {
          ...(await this.productData(session, input)),
          stockOnHand: 0,
          companyId: session.companyId,
        },
        select: productSelect,
      });
      return mapProductToDto(row);
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) throw this.skuConflict();
      throw error;
    }
  }

  async update(session: SessionContext, id: string, input: ProductInput): Promise<ProductDto> {
    try {
      const result = await this.database.product.updateMany({
        where: { id, companyId: session.companyId },
        data: await this.productData(session, input),
      });
      if (result.count === 0) throw this.notFound();
      const row = await this.database.product.findUnique({
        where: { id_companyId: { id, companyId: session.companyId } },
        select: productSelect,
      });
      if (!row) throw this.notFound();
      return mapProductToDto(row);
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) throw this.skuConflict();
      throw error;
    }
  }

  async addMovement(
    session: SessionContext,
    id: string,
    input: StockMovementInput,
  ): Promise<StockMovementDto> {
    return this.database.$transaction(async (tx) => {
      const type = input.action === "Ingreso" ? "INGRESO" : "SALIDA";
      if (type === "INGRESO") {
        const changed = await tx.product.updateMany({
          where: { id, companyId: session.companyId },
          data: { stockOnHand: { increment: input.quantity } },
        });
        if (!changed.count) throw this.notFound();
      } else {
        const changed = await tx.product.updateMany({
          where: { id, companyId: session.companyId, stockOnHand: { gte: input.quantity } },
          data: { stockOnHand: { decrement: input.quantity } },
        });
        if (!changed.count) {
          if (
            !(await tx.product.findUnique({
              where: { id_companyId: { id, companyId: session.companyId } },
              select: { id: true },
            }))
          )
            throw this.notFound();
          throw this.businessRule("product.stock.insufficient");
        }
      }
      const movement = await tx.stockMovement.create({
        data: {
          companyId: session.companyId,
          productId: id,
          type,
          quantity: type === "INGRESO" ? input.quantity : -input.quantity,
          note: input.note,
          reference: "",
        },
        select: movementSelect,
      });
      return (await this.mapMovements(tx, [movement]))[0]!;
    });
  }

  async adjustStock(
    session: SessionContext,
    id: string,
    input: StockAdjustmentInput,
  ): Promise<StockMovementDto> {
    return this.database.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ stock_on_hand: number }>
      >`SELECT stock_on_hand FROM products WHERE id = ${id} AND company_id = ${session.companyId} FOR UPDATE`;
      const current = rows[0]?.stock_on_hand;
      if (current === undefined) throw this.notFound();
      const delta = input.targetStock - current;
      if (delta === 0)
        throw new ApiException("validation", messageKey("product.stock.unchanged"), 400);
      await tx.product.update({
        where: { id_companyId: { id, companyId: session.companyId } },
        data: { stockOnHand: input.targetStock },
      });
      const movement = await tx.stockMovement.create({
        data: {
          companyId: session.companyId,
          productId: id,
          type: "AJUSTE",
          quantity: delta,
          note: input.note,
          reference: "",
        },
        select: movementSelect,
      });
      return (await this.mapMovements(tx, [movement]))[0]!;
    });
  }

  async reverseMovement(
    session: SessionContext,
    id: string,
    movementId: string,
    input: ReversalInput,
  ): Promise<StockMovementDto> {
    try {
      return await this.database.$transaction(async (tx) => {
        const original = await tx.stockMovement.findUnique({
          where: { id_companyId: { id: movementId, companyId: session.companyId } },
          select: movementSelect,
        });
        if (!original || original.productId !== id) throw this.notFound();
        if (original.type === "REVERSION")
          throw this.businessRule("product.movement.cannotReverseReversal");
        const alreadyReversed = await tx.stockMovement.findFirst({
          where: { companyId: session.companyId, reversesMovementId: original.id },
          select: { id: true },
        });
        if (alreadyReversed)
          throw new ApiException("conflict", messageKey("product.movement.reversed"), 409);
        const quantity = -original.quantity;
        if (quantity < 0) {
          const changed = await tx.product.updateMany({
            where: { id, companyId: session.companyId, stockOnHand: { gte: -quantity } },
            data: { stockOnHand: { decrement: -quantity } },
          });
          if (!changed.count) throw this.businessRule("product.stock.reversalNegative");
        } else {
          const changed = await tx.product.updateMany({
            where: { id, companyId: session.companyId },
            data: { stockOnHand: { increment: quantity } },
          });
          if (!changed.count) throw this.notFound();
        }
        const row = await tx.stockMovement.create({
          data: {
            companyId: session.companyId,
            productId: id,
            type: "REVERSION",
            quantity,
            reference: original.reference,
            note: input.reason,
            reversesMovementId: original.id,
            documentId: original.documentId,
          },
          select: movementSelect,
        });
        return (await this.mapMovements(tx, [row]))[0]!;
      });
    } catch (error: unknown) {
      if (this.isUniqueViolation(error))
        throw new ApiException("conflict", messageKey("product.movement.reversed"), 409);
      throw error;
    }
  }

  async movements(
    session: SessionContext,
    id: string,
    query: ProductMovementQuery,
  ): Promise<{ items: StockMovementDto[]; nextCursor: string | null }> {
    if (
      !(await this.database.product.findUnique({
        where: { id_companyId: { id, companyId: session.companyId } },
        select: { id: true },
      }))
    )
      throw this.notFound();
    const cursor = query.cursor ? decodeProductMovementCursor(query.cursor) : null;
    const rows = await this.database.stockMovement.findMany({
      where: {
        companyId: session.companyId,
        productId: id,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.t) } },
                { createdAt: new Date(cursor.t), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      select: movementSelect,
    });
    const hasMore = rows.length > query.limit;
    const selected = hasMore ? rows.slice(0, query.limit) : rows;
    const last = selected.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeProductMovementCursor({ t: last.createdAt.toISOString(), id: last.id })
        : null;
    return { items: await this.mapMovements(this.database, selected), nextCursor };
  }

  async globalMovements(
    session: SessionContext,
    type: string | undefined,
    productId: string | undefined,
    from: string | undefined,
    to: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<Page<StockMovementDto>> {
    const where: Prisma.StockMovementWhereInput = {
      companyId: session.companyId,
      ...(productId ? { productId } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: argentinaDayStart(from) } : {}),
              ...(to ? { lt: argentinaDayEndExclusive(to) } : {}),
            },
          }
        : {}),
      ...(type
        ? {
            type:
              type === "Ingreso"
                ? ("INGRESO" as const)
                : type === "Salida"
                  ? ("SALIDA" as const)
                  : type === "Ajuste"
                    ? ("AJUSTE" as const)
                    : ("REVERSION" as const),
          }
        : {}),
    };
    const { skip, take } = paginate(page, pageSize);
    const [rows, total] = await Promise.all([
      this.database.stockMovement.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
        select: movementSelect,
      }),
      this.database.stockMovement.count({ where }),
    ]);
    return { items: await this.mapMovements(this.database, rows), page, pageSize, total };
  }

  private async mapMovements(
    client: Pick<DatabaseService, "stockMovement"> | Prisma.TransactionClient,
    rows: readonly Prisma.StockMovementGetPayload<{ select: typeof movementSelect }>[],
  ): Promise<StockMovementDto[]> {
    const ids = rows.map((row) => row.id);
    const reversals = ids.length
      ? await client.stockMovement.findMany({
          where: { companyId: rows[0]!.companyId, reversesMovementId: { in: ids } },
          select: { reversesMovementId: true },
        })
      : [];
    const reversed = new Set(
      reversals.flatMap((row) => (row.reversesMovementId ? [row.reversesMovementId] : [])),
    );
    return rows.map((row) => mapMovementToDto(row, reversed));
  }

  private async productData(session: SessionContext, input: ProductInput) {
    const category = await this.database.elemSubType.findUnique({
      where: { id_companyId: { id: input.categoryId, companyId: session.companyId } },
      select: { description: true, elemTypeId: true },
    });
    if (category?.elemTypeId !== "PROD_CAT")
      throw new ApiException("validation", messageKey("product.category.notFound"), 400, {
        categoryId: ["product.category.notFound"],
      });
    return {
      ...mapProductInput(input),
      ...buildProductIndexFields({ ...input, category: category.description }),
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
  private skuConflict(): ApiException {
    return new ApiException("conflict", messageKey("product.sku.conflict"), 409, {
      sku: ["product.sku.conflict"],
    });
  }
  private notFound(): ApiException {
    return new ApiException("not_found", messageKey("product.notFound"), 404);
  }
  private businessRule(message: MessageKey): ApiException {
    return new ApiException("business_rule", message, 422);
  }
}
