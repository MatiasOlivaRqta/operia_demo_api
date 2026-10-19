import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import type { SessionContext } from "../common/request-context.js";
import { DatabaseService } from "../database/database.service.js";
import { ProductsService } from "../products/products.service.js";
import type { InventoryMovementQuery } from "./inventory.schemas.js";

type InventoryAggregate = {
  activeProducts: bigint;
  totalUnits: bigint;
  lowStockCount: bigint;
  inventoryValueCents: bigint;
};

@Injectable()
export class InventoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly products: ProductsService,
  ) {}

  async summary(session: SessionContext): Promise<{
    activeProducts: number;
    totalUnits: number;
    lowStockCount: number;
    inventoryValueCents: number;
  }> {
    const rows = await this.database.$queryRaw<InventoryAggregate[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "activeProducts",
        COALESCE(SUM(stock_on_hand), 0)::bigint AS "totalUnits",
        COUNT(*) FILTER (WHERE stock_on_hand <= minimum_stock)::bigint AS "lowStockCount",
        COALESCE(SUM(stock_on_hand::bigint * cost_cents), 0)::bigint AS "inventoryValueCents"
      FROM products WHERE company_id = ${session.companyId} AND status = 'ACTIVE'
    `);
    const row = rows[0];
    return {
      activeProducts: Number(row?.activeProducts ?? 0n),
      totalUnits: Number(row?.totalUnits ?? 0n),
      lowStockCount: Number(row?.lowStockCount ?? 0n),
      inventoryValueCents: Number(row?.inventoryValueCents ?? 0n),
    };
  }

  movements(session: SessionContext, query: InventoryMovementQuery) {
    return this.products.globalMovements(
      session,
      query.type,
      query.productId,
      query.from,
      query.to,
      query.page,
      query.pageSize,
    );
  }
}
