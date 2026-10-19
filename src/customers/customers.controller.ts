import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import {
  customerIdSchema,
  customerQuerySchema,
  customerSchema,
  customerStatusSchema,
  type CustomerInput,
  type CustomerQuery,
  type CustomerStatusInput,
} from "./customer.schemas.js";
import { CustomersService } from "./customers.service.js";

@Controller("customers")
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission("customers.read", "documents.write")
  list(
    @Query(new ZodValidationPipe(customerQuerySchema)) query: CustomerQuery,
    @CurrentSession() session: SessionContext,
  ) {
    return this.customers.list(session, query);
  }

  @Get(":id")
  @RequirePermission("customers.read", "documents.write")
  get(
    @Param(new ZodValidationPipe(customerIdSchema)) params: { id: string },
    @CurrentSession() session: SessionContext,
  ) {
    return this.customers.get(session, params.id);
  }

  @Post()
  @RequirePermission("customers.write")
  create(
    @Body(new ZodValidationPipe(customerSchema)) input: CustomerInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.customers.create(session, input);
  }

  @Patch(":id")
  @RequirePermission("customers.write")
  update(
    @Param(new ZodValidationPipe(customerIdSchema)) params: { id: string },
    @Body(new ZodValidationPipe(customerSchema)) input: CustomerInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.customers.update(session, params.id, input);
  }

  @Post(":id/deactivation")
  @RequirePermission("customers.write")
  deactivate(
    @Param(new ZodValidationPipe(customerIdSchema)) params: { id: string },
    @CurrentSession() session: SessionContext,
  ) {
    return this.customers.deactivate(session, params.id);
  }

  @Patch(":id/status")
  @RequirePermission("customers.write")
  setStatus(
    @Param(new ZodValidationPipe(customerIdSchema)) params: { id: string },
    @Body(new ZodValidationPipe(customerStatusSchema)) body: CustomerStatusInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.customers.setStatus(session, params.id, body.status);
  }
}
