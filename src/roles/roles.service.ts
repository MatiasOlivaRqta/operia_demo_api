import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { ApiException } from "../common/errors.js";
import { messageKey } from "../common/i18n/index.js";
import type { SessionContext } from "../common/request-context.js";
import { DatabaseService } from "../database/database.service.js";
import { PERMISSION_CATALOG } from "../permissions/permissions.catalog.js";
import { permissionsForRole } from "../permissions/permissions.service.js";
import type { CreateRoleInput, UpdateRoleInput } from "./role.schemas.js";

type RoleDto = {
  id: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
  userCount?: number;
};

@Injectable()
export class RolesService {
  constructor(private readonly database: DatabaseService) {}

  permissions() {
    return Object.entries(PERMISSION_CATALOG).map(([module, permissions]) => ({
      module,
      permissions: [...permissions],
    }));
  }

  async list(session: SessionContext): Promise<RoleDto[]> {
    const roles = await this.database.role.findMany({
      where: { companyId: session.companyId },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      include: { _count: { select: { memberships: true } } },
    });
    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      isSystem: role.isSystem,
      permissions: permissionsForRole(role),
      userCount: role._count.memberships,
    }));
  }

  async create(session: SessionContext, input: CreateRoleInput): Promise<RoleDto> {
    await this.ensureUniqueName(session.companyId, input.name);
    try {
      const role = await this.database.role.create({
        data: { ...input, companyId: session.companyId },
      });
      return {
        id: role.id,
        name: role.name,
        isSystem: role.isSystem,
        permissions: role.permissions,
      };
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) throw this.nameConflict();
      throw error;
    }
  }

  async update(session: SessionContext, id: string, input: UpdateRoleInput): Promise<RoleDto> {
    const current = await this.database.role.findFirst({
      where: { id, companyId: session.companyId },
    });
    if (!current) throw this.notFound();
    if (current.isSystem) throw this.systemRoleConflict();
    if (input.name) await this.ensureUniqueName(session.companyId, input.name, id);
    try {
      const result = await this.database.role.updateMany({
        where: { id, companyId: session.companyId, isSystem: false },
        data: input,
      });
      if (result.count !== 1) throw this.notFound();
      const role = await this.database.role.findFirst({
        where: { id, companyId: session.companyId },
      });
      if (!role) throw this.notFound();
      return {
        id: role.id,
        name: role.name,
        isSystem: role.isSystem,
        permissions: role.permissions,
      };
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) throw this.nameConflict();
      throw error;
    }
  }

  async remove(session: SessionContext, id: string): Promise<void> {
    const current = await this.database.role.findFirst({
      where: { id, companyId: session.companyId },
    });
    if (!current) throw this.notFound();
    if (current.isSystem) throw this.systemRoleConflict();
    const assigned = await this.database.membership.count({
      where: { roleId: id, companyId: session.companyId },
    });
    if (assigned > 0) throw this.roleInUse();
    try {
      const deleted = await this.database.role.deleteMany({
        where: { id, companyId: session.companyId, isSystem: false },
      });
      if (deleted.count !== 1) throw this.notFound();
    } catch (error: unknown) {
      if (this.isForeignKeyViolation(error)) throw this.roleInUse();
      throw error;
    }
  }

  private async ensureUniqueName(
    companyId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const existing = await this.database.role.findFirst({
      where: { companyId, name, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    if (existing) throw this.nameConflict();
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      (Prisma.PrismaClientKnownRequestError &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002") ||
      (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
    );
  }
  private isForeignKeyViolation(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "P2003" || error.code === "P2014")
    );
  }
  private nameConflict(): ApiException {
    return new ApiException("validation", messageKey("validation.reviewInput"), 400, {
      name: ["role.name.conflict"],
    });
  }
  private systemRoleConflict(): ApiException {
    return new ApiException("conflict", messageKey("role.system.immutable"), 409);
  }
  private roleInUse(): ApiException {
    return new ApiException("conflict", messageKey("role.inUse"), 409);
  }
  private notFound(): ApiException {
    return new ApiException("not_found", messageKey("role.notFound"), 404);
  }
}
