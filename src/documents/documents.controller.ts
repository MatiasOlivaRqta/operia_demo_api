import { Body, Controller, Get, Headers, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import {
  cancellationSchema,
  createDocumentSchema,
  documentIdSchema,
  documentCollectionsParamsSchema,
  documentQuerySchema,
  type CancellationInput,
  type CreateDocumentInput,
  type DocumentQuery,
  type DocumentCollectionsParams,
} from "./document.schemas.js";
import { DocumentsService } from "./documents.service.js";

@Controller("documents")
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @RequirePermission("documents.read")
  list(
    @Query(new ZodValidationPipe(documentQuerySchema)) query: DocumentQuery,
    @CurrentSession() session: SessionContext,
  ) {
    return this.documents.list(session, query);
  }

  @Get(":id")
  @RequirePermission("documents.read")
  get(
    @Param(new ZodValidationPipe(documentIdSchema)) params: { id: string },
    @CurrentSession() session: SessionContext,
  ) {
    return this.documents.get(session, params.id);
  }

  @Get(":id/collections")
  @RequirePermission("documents.read", "account.read")
  collections(
    @Param(new ZodValidationPipe(documentCollectionsParamsSchema))
    params: DocumentCollectionsParams,
    @CurrentSession() session: SessionContext,
  ) {
    return this.documents.collections(session, params.id);
  }

  @Post()
  @RequirePermission("documents.write")
  create(
    @Headers("idempotency-key") key: string | undefined,
    @Body(new ZodValidationPipe(createDocumentSchema)) input: CreateDocumentInput,
    @CurrentSession() session: SessionContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.documents.create(session, input, key).then((result) => {
      if (result.replayed) response.status(200);
      return result.document;
    });
  }

  @Post(":id/cancellation")
  @RequirePermission("documents.cancel")
  cancel(
    @Param(new ZodValidationPipe(documentIdSchema)) params: { id: string },
    @Body(new ZodValidationPipe(cancellationSchema)) input: CancellationInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.documents.cancel(session, params.id, input);
  }
}
