import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import { cashMovementQuerySchema, type CashMovementQuery } from "./cash.schemas.js";
import { CashService } from "./cash.service.js";
import { CashSessionsService } from "./cash-sessions.service.js";
import { CashCollectionsService } from "./cash-collections.service.js";
import { cashCollectionSchema, type CashCollectionInput } from "./cash-collections.schemas.js";
import {
  cashSessionIdSchema,
  closeCashSessionSchema,
  openCashSessionSchema,
  type CloseCashSessionInput,
  type OpenCashSessionInput,
} from "./cash-sessions.schemas.js";

@Controller("cash")
export class CashController {
  constructor(
    private readonly cash: CashService,
    private readonly sessions: CashSessionsService,
    private readonly collections: CashCollectionsService,
  ) {}

  @Post("sessions")
  @RequirePermission("cash.write")
  openSession(
    @Body(new ZodValidationPipe(openCashSessionSchema)) input: OpenCashSessionInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.sessions.open(session, input);
  }

  @Get("sessions/current")
  @RequirePermission("cash.read")
  async currentSession(
    @CurrentSession() session: SessionContext,
    @Res() response: Response,
  ): Promise<void> {
    response.json(await this.sessions.current(session));
  }

  @Post("sessions/:id/close")
  @RequirePermission("cash.write")
  @HttpCode(200)
  closeSession(
    @Param(new ZodValidationPipe(cashSessionIdSchema)) params: { id: string },
    @Body(new ZodValidationPipe(closeCashSessionSchema)) input: CloseCashSessionInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.sessions.close(session, params.id, input);
  }

  @Post("sessions/:id/collections")
  @RequirePermission("cash.write")
  async collect(
    @Param(new ZodValidationPipe(cashSessionIdSchema)) params: { id: string },
    @Headers("idempotency-key") key: string | undefined,
    @Body(new ZodValidationPipe(cashCollectionSchema)) input: CashCollectionInput,
    @CurrentSession() session: SessionContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.collections.collect(session, params.id, input, key);
    if (result.replayed) response.status(200);
    return result.receipt;
  }

  @Get("movements")
  @RequirePermission("cash.read")
  listMovements(
    @Query(new ZodValidationPipe(cashMovementQuerySchema)) query: CashMovementQuery,
    @CurrentSession() session: SessionContext,
  ) {
    return this.cash.listMovements(session, query);
  }

  // Nest no serializa un `null` devuelto por el handler (responde sin cuerpo);
  // la API promete el JSON `null` cuando no hay caja abierta.
  @Get("sessions/current/totals")
  @RequirePermission("cash.read")
  async currentTotals(
    @CurrentSession() session: SessionContext,
    @Res() response: Response,
  ): Promise<void> {
    response.json(await this.cash.currentTotals(session));
  }
}
