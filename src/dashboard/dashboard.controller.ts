import { Controller, Get, Query } from "@nestjs/common";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import { dashboardActivityQuerySchema, type DashboardActivityQuery } from "./dashboard.schemas.js";
import { DashboardService } from "./dashboard.service.js";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("summary")
  @RequirePermission("dashboard.read")
  summary(@CurrentSession() session: SessionContext) {
    return this.dashboard.summary(session);
  }

  @Get("activity")
  @RequirePermission("dashboard.read")
  activity(
    @Query(new ZodValidationPipe(dashboardActivityQuerySchema)) query: DashboardActivityQuery,
    @CurrentSession() session: SessionContext,
  ) {
    return this.dashboard.activity(session, query);
  }
}
