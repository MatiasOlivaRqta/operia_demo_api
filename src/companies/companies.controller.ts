import { Controller, Get, Param, Put } from "@nestjs/common";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { companyIdSchema } from "../auth/auth.schemas.js";
import { AuthService } from "../auth/auth.service.js";
import { DatabaseService } from "../database/database.service.js";

@Controller()
export class CompaniesController {
  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
  ) {}

  @Get("companies")
  async list(@CurrentSession() session: SessionContext) {
    const memberships = await this.database.membership.findMany({
      where: { userId: session.userId },
      orderBy: { companyId: "asc" },
      select: { company: { select: { id: true, legalName: true, name: true } } },
    });
    return memberships.map(({ company }) => company);
  }

  @Put("session/company/:id")
  async setActive(
    @Param("id", new ZodValidationPipe(companyIdSchema.shape.id)) companyId: string,
    @CurrentSession() session: SessionContext,
  ) {
    return this.auth.setActiveCompany(session.userId, session.sessionId, companyId);
  }
}
