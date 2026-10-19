import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import {
  createUserSchema,
  updateUserSchema,
  userIdSchema,
  type CreateUserInput,
  type UpdateUserInput,
} from "./user.schemas.js";
import { UsersService } from "./users.service.js";

@Controller("users")
@RequirePermission("users.manage")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@CurrentSession() session: SessionContext) {
    return this.users.list(session);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createUserSchema)) input: CreateUserInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.users.create(session, input);
  }

  @Patch(":id")
  update(
    @Param(new ZodValidationPipe(userIdSchema)) params: { id: string },
    @Body(new ZodValidationPipe(updateUserSchema)) input: UpdateUserInput,
    @CurrentSession() session: SessionContext,
  ) {
    return this.users.update(session, params.id, input);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(
    @Param(new ZodValidationPipe(userIdSchema)) params: { id: string },
    @CurrentSession() session: SessionContext,
  ) {
    return this.users.remove(session, params.id);
  }
}
