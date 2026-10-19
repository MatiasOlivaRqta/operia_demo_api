import { Controller, Get, Query } from "@nestjs/common";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import { InventoryService } from "./inventory.service.js";
import { inventoryMovementQuerySchema, type InventoryMovementQuery } from "./inventory.schemas.js";

@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get("inventory/summary")
  @RequirePermission("inventory.read")
  summary(@CurrentSession() session: SessionContext) {
    return this.inventory.summary(session);
  }

  @Get("stock-movements")
  @RequirePermission("inventory.read")
  movements(
    @Query(new ZodValidationPipe(inventoryMovementQuerySchema)) query: InventoryMovementQuery,
    @CurrentSession() session: SessionContext,
  ) {
    return this.inventory.movements(session, query);
  }
}
