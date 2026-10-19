import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";
import { Prisma } from "../generated/prisma/client.js";
import { ApiException } from "../common/errors.js";
import { messageKey } from "../common/i18n/index.js";
import type { SessionContext } from "../common/request-context.js";
import { DatabaseService } from "../database/database.service.js";
import type { CreateUserInput, UpdateUserInput } from "./user.schemas.js";

type UserDto = { id: string; email: string; name: string; role: { id: string; name: string } };

@Injectable()
export class UsersService {
  constructor(private readonly database: DatabaseService) {}

  async list(session: SessionContext): Promise<UserDto[]> {
    const memberships = await this.database.membership.findMany({
      where: { companyId: session.companyId },
      orderBy: [{ user: { name: "asc" } }, { user: { email: "asc" } }],
      select: {
        user: { select: { id: true, email: true, name: true } },
        role: { select: { id: true, name: true } },
      },
    });
    return memberships.map(({ user, role }) => ({ ...user, role }));
  }

  async create(session: SessionContext, input: CreateUserInput): Promise<UserDto> {
    await this.validateRole(this.database, session.companyId, input.roleId);
    try {
      return await this.createOrAddMembership(
        session.companyId,
        input,
        await argon2.hash(input.password, { type: argon2.argon2id }),
      );
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) {
        try {
          return await this.createOrAddMembership(session.companyId, input);
        } catch (retryError: unknown) {
          if (this.isUniqueViolation(retryError)) throw this.emailConflict();
          throw retryError;
        }
      }
      throw error;
    }
  }

  async update(session: SessionContext, userId: string, input: UpdateUserInput): Promise<UserDto> {
    return this.database.$transaction(async (transaction) => {
      await this.lockAdminRole(transaction, session.companyId);
      const target = await transaction.membership.findUnique({
        where: { userId_companyId: { userId, companyId: session.companyId } },
        select: { userId: true, role: { select: { name: true } } },
      });
      if (!target) throw this.notFound();
      const newRole = await this.roleInCompany(transaction, session.companyId, input.roleId);
      if (target.role.name === "ADMIN" && newRole.name !== "ADMIN") {
        const otherAdmins = await transaction.membership.count({
          where: { companyId: session.companyId, userId: { not: userId }, role: { name: "ADMIN" } },
        });
        if (otherAdmins === 0) throw this.lastAdmin();
      }
      await transaction.membership.update({
        where: { userId_companyId: { userId, companyId: session.companyId } },
        data: { roleId: input.roleId },
      });
      const user = await transaction.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true },
      });
      if (!user) throw this.notFound();
      return { ...user, role: { id: newRole.id, name: newRole.name } };
    });
  }

  async remove(session: SessionContext, userId: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await this.lockAdminRole(transaction, session.companyId);
      if (userId === session.userId) throw this.selfRemoval();
      const target = await transaction.membership.findUnique({
        where: { userId_companyId: { userId, companyId: session.companyId } },
        select: { userId: true, role: { select: { name: true } } },
      });
      if (!target) throw this.notFound();
      if (target.role.name === "ADMIN") {
        const otherAdmins = await transaction.membership.count({
          where: { companyId: session.companyId, userId: { not: userId }, role: { name: "ADMIN" } },
        });
        if (otherAdmins === 0) throw this.lastAdmin();
      }
      await transaction.membership.delete({
        where: { userId_companyId: { userId, companyId: session.companyId } },
      });
    });
  }

  private async createOrAddMembership(
    companyId: string,
    input: CreateUserInput,
    passwordHash?: string,
  ): Promise<UserDto> {
    return this.database.$transaction(async (transaction) => {
      const role = await this.roleInCompany(transaction, companyId, input.roleId);
      const existing = await transaction.user.findUnique({
        where: { email: input.email },
        select: { id: true, email: true, name: true },
      });
      if (existing) {
        const membership = await transaction.membership.findUnique({
          where: { userId_companyId: { userId: existing.id, companyId } },
          select: { userId: true },
        });
        if (membership) throw this.emailConflict();
        await transaction.membership.create({
          data: { userId: existing.id, companyId, roleId: role.id },
        });
        return { ...existing, role: { id: role.id, name: role.name } };
      }
      if (!passwordHash) throw this.emailConflict();
      const user = await transaction.user.create({
        data: { email: input.email, name: input.name, passwordHash },
        select: { id: true, email: true, name: true },
      });
      await transaction.membership.create({
        data: { userId: user.id, companyId, roleId: role.id },
      });
      return { ...user, role: { id: role.id, name: role.name } };
    });
  }

  private async validateRole(
    database: DatabaseService,
    companyId: string,
    roleId: string,
  ): Promise<void> {
    const role = await database.role.findFirst({
      where: { id: roleId, companyId },
      select: { id: true },
    });
    if (!role) throw this.roleInvalid();
  }
  private async roleInCompany(client: Prisma.TransactionClient, companyId: string, roleId: string) {
    const role = await client.role.findFirst({
      where: { id: roleId, companyId },
      select: { id: true, name: true },
    });
    if (!role) throw this.roleInvalid();
    return role;
  }
  private async lockAdminRole(client: Prisma.TransactionClient, companyId: string): Promise<void> {
    await client.$queryRaw`SELECT id FROM roles WHERE company_id = ${companyId} AND name = 'ADMIN' FOR UPDATE`;
  }
  private isUniqueViolation(error: unknown): boolean {
    return (
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
      (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
    );
  }
  private roleInvalid(): ApiException {
    return new ApiException("validation", messageKey("validation.reviewInput"), 400, {
      roleId: ["user.role.invalid"],
    });
  }
  private emailConflict(): ApiException {
    return new ApiException("conflict", messageKey("error.conflict"), 409, {
      email: ["user.email.conflict"],
    });
  }
  private lastAdmin(): ApiException {
    return new ApiException("business_rule", messageKey("user.admin.last"), 422);
  }
  private selfRemoval(): ApiException {
    return new ApiException("business_rule", messageKey("user.admin.selfRemoval"), 422);
  }
  private notFound(): ApiException {
    return new ApiException("not_found", messageKey("user.notFound"), 404);
  }
}
