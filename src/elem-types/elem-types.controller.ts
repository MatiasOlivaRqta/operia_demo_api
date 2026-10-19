import { Body, Controller, Get, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import {
  subTypeParamsSchema,
  subTypeQuerySchema,
  subTypeSchema,
  type SubTypeInput,
  type SubTypeQuery,
} from "./elem-type.schemas.js";
import { ElemTypesService } from "./elem-types.service.js";

@Controller("elem-types/:typeId/sub-types")
export class ElemTypesController {
  constructor(private readonly elemTypes: ElemTypesService) {}

  @Get()
  @RequirePermission("products.read")
  list(
    @Param(new ZodValidationPipe(subTypeParamsSchema)) params: { typeId: string },
    @Query(new ZodValidationPipe(subTypeQuerySchema)) query: SubTypeQuery,
    @CurrentSession() session: SessionContext,
  ) {
    return this.elemTypes.listSubTypes(session, params.typeId, query);
  }

  @Post()
  @RequirePermission("products.write")
  async create(
    @Param(new ZodValidationPipe(subTypeParamsSchema)) params: { typeId: string },
    @Body(new ZodValidationPipe(subTypeSchema)) input: SubTypeInput,
    @CurrentSession() session: SessionContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { created, subType } = await this.elemTypes.createSubType(session, params.typeId, input);
    response.status(created ? 201 : 200);
    return subType;
  }
}
