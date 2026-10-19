import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import {
  accountCustomerParamsSchema,
  accountCollectionParamsSchema,
  accountQuerySchema,
  accountApplicationSchema,
  accountMovementsQuerySchema,
  type AccountQuery,
  type AccountApplicationInput,
  type AccountMovementsQuery,
  type AccountCollectionParams,
} from "./customer-account.schemas.js";
import { CustomerAccountService } from "./customer-account.service.js";

@Controller("customers/:id/account")
export class CustomerAccountController {
  constructor(private readonly account: CustomerAccountService) {}

  @Post("applications")
  @RequirePermission("account.write")
  apply(
    @Param(new ZodValidationPipe(accountCustomerParamsSchema)) params: { id: string },
    @Body(new ZodValidationPipe(accountApplicationSchema)) input: AccountApplicationInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.account.applyCredit(session.companyId, params.id, input);
  }

  @Get()
  @RequirePermission("account.read")
  get(
    @Param(new ZodValidationPipe(accountCustomerParamsSchema)) params: { id: string },
    @Query(new ZodValidationPipe(accountQuerySchema)) query: AccountQuery,
    @CurrentSession() session: SessionContext,
  ) {
    return this.account.getAccount(session.companyId, params.id, query);
  }

  @Get("summary")
  @RequirePermission("account.read")
  summary(
    @Param(new ZodValidationPipe(accountCustomerParamsSchema)) params: { id: string },
    @CurrentSession() session: SessionContext,
  ) {
    return this.account.getSummary(session.companyId, params.id);
  }

  @Get("movements")
  @RequirePermission("account.read")
  movements(
    @Param(new ZodValidationPipe(accountCustomerParamsSchema)) params: { id: string },
    @Query(new ZodValidationPipe(accountMovementsQuerySchema)) query: AccountMovementsQuery,
    @CurrentSession() session: SessionContext,
  ) {
    return this.account.listMovements(session.companyId, params.id, query);
  }

  @Get("collections/:cashMovementId")
  @RequirePermission("account.read")
  collections(
    @Param(new ZodValidationPipe(accountCollectionParamsSchema)) params: AccountCollectionParams,
    @CurrentSession() session: SessionContext,
  ) {
    return this.account.getCollectionApplications(
      session.companyId,
      params.id,
      params.cashMovementId,
    );
  }
}
