import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import { ProductsService } from "./products.service.js";
import {
  movementIdSchema,
  productIdSchema,
  productMovementQuerySchema,
  productQuerySchema,
  productSchema,
  reversalSchema,
  stockAdjustmentSchema,
  stockMovementSchema,
  type ProductInput,
  type ProductMovementQuery,
  type ProductQuery,
  type ReversalInput,
  type StockAdjustmentInput,
  type StockMovementInput,
} from "./product.schemas.js";

@Controller("products")
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermission("products.read", "documents.write")
  list(
    @Query(new ZodValidationPipe(productQuerySchema)) query: ProductQuery,
    @CurrentSession() session: SessionContext,
  ) {
    return this.products.list(session, query);
  }

  @Get(":id/movements")
  @RequirePermission("inventory.read")
  movements(
    @Param(new ZodValidationPipe(productIdSchema)) params: { id: string },
    @Query(new ZodValidationPipe(productMovementQuerySchema)) query: ProductMovementQuery,
    @CurrentSession() session: SessionContext,
  ) {
    return this.products.movements(session, params.id, query);
  }

  @Post(":id/stock-movements")
  @RequirePermission("inventory.write")
  addMovement(
    @Param(new ZodValidationPipe(productIdSchema)) params: { id: string },
    @Body(new ZodValidationPipe(stockMovementSchema)) input: StockMovementInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.products.addMovement(session, params.id, input);
  }

  @Post(":id/stock-adjustments")
  @RequirePermission("inventory.write")
  adjustStock(
    @Param(new ZodValidationPipe(productIdSchema)) params: { id: string },
    @Body(new ZodValidationPipe(stockAdjustmentSchema)) input: StockAdjustmentInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.products.adjustStock(session, params.id, input);
  }

  @Post(":id/stock-movements/:movementId/reversal")
  @RequirePermission("inventory.cancel")
  reverseMovement(
    @Param(new ZodValidationPipe(movementIdSchema)) params: { id: string; movementId: string },
    @Body(new ZodValidationPipe(reversalSchema)) input: ReversalInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.products.reverseMovement(session, params.id, params.movementId, input);
  }

  @Get(":id")
  @RequirePermission("products.read", "documents.write")
  get(
    @Param(new ZodValidationPipe(productIdSchema)) params: { id: string },
    @CurrentSession() session: SessionContext,
  ) {
    return this.products.get(session, params.id);
  }

  @Post()
  @RequirePermission("products.write")
  create(
    @Body(new ZodValidationPipe(productSchema)) input: ProductInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.products.create(session, input);
  }

  @Patch(":id")
  @RequirePermission("products.write")
  update(
    @Param(new ZodValidationPipe(productIdSchema)) params: { id: string },
    @Body(new ZodValidationPipe(productSchema)) input: ProductInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.products.update(session, params.id, input);
  }
}
