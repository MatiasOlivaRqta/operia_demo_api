import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import {
  createRoleSchema,
  roleIdSchema,
  updateRoleSchema,
  type CreateRoleInput,
  type UpdateRoleInput,
} from "./role.schemas.js";
import { RolesService } from "./roles.service.js";

@Controller("roles")
@RequirePermission("users.manage")
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get("permissions")
  permissions() {
    return this.roles.permissions();
  }

  @Get()
  list(@CurrentSession() session: SessionContext) {
    return this.roles.list(session);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createRoleSchema)) input: CreateRoleInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.roles.create(session, input);
  }

  @Patch(":id")
  update(
    @Param(new ZodValidationPipe(roleIdSchema)) params: { id: string },
    @Body(new ZodValidationPipe(updateRoleSchema)) input: UpdateRoleInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.roles.update(session, params.id, input);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(
    @Param(new ZodValidationPipe(roleIdSchema)) params: { id: string },
    @CurrentSession() session: SessionContext,
  ) {
    return this.roles.remove(session, params.id);
  }
}
