import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import {
  notificationIdSchema,
  notificationsQuerySchema,
  type NotificationsQuery,
} from "./notifications.schemas.js";
import { NotificationsService } from "./notifications.service.js";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission("dashboard.read")
  list(
    @Query(new ZodValidationPipe(notificationsQuerySchema)) query: NotificationsQuery,
    @CurrentSession() session: SessionContext,
  ) {
    return this.notifications.list(session.companyId, query.page, query.pageSize);
  }

  @Get("unread-count")
  @RequirePermission("dashboard.read")
  async unreadCount(@CurrentSession() session: SessionContext) {
    return { count: await this.notifications.unreadCount(session.companyId) };
  }

  @Post(":id/read")
  @RequirePermission("dashboard.read")
  @HttpCode(HttpStatus.OK)
  async markRead(
    @Param(new ZodValidationPipe(notificationIdSchema)) params: { id: string },
    @CurrentSession() session: SessionContext,
  ) {
    await this.notifications.markRead(session.companyId, params.id);
    return { ok: true };
  }

  @Post("read-all")
  @RequirePermission("dashboard.read")
  @HttpCode(HttpStatus.OK)
  async markAllRead(@CurrentSession() session: SessionContext) {
    return { updated: await this.notifications.markAllRead(session.companyId) };
  }
}
