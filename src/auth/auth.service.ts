import { messageKey } from "../common/i18n/index.js";
import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";
import { ApiException } from "../common/errors.js";
import { DatabaseService } from "../database/database.service.js";
import { env } from "../config/env.js";
import type { LoginInput } from "./auth.schemas.js";
import { createSessionToken, hashSessionToken } from "./session-token.js";
import type { SessionContext } from "../common/request-context.js";
import { permissionsForRole } from "../permissions/permissions.service.js";

const SESSION_COOKIE = "operia_session";
const GENERIC_LOGIN_ERROR = messageKey("auth.login.invalid");
const dummyHash = argon2.hash("not-a-real-user-password", { type: argon2.argon2id });

type PublicUser = { id: string; email: string; name: string };
type PublicCompany = { id: string; legalName: string; name: string };
type MembershipWithRole = {
  companyId: string;
  company: PublicCompany;
  role: { id: string; name: string; isSystem: boolean; permissions: string[] };
};
export type SessionPayload = {
  user: PublicUser;
  companies: PublicCompany[];
  activeCompany: PublicCompany;
  role: { id: string; name: string };
  permissions: string[];
};

type LoginResult = { payload: SessionPayload; token: string; expiresAt: Date };

@Injectable()
export class AuthService {
  constructor(private readonly database: DatabaseService) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const email = input.email.trim().normalize("NFC").toLowerCase();
    const user = await this.database.user.findUnique({
      where: { email },
      include: {
        memberships: {
          include: {
            company: true,
            role: { select: { id: true, name: true, isSystem: true, permissions: true } },
          },
          orderBy: { companyId: "asc" },
        },
      },
    });
    const hash = user?.passwordHash ?? (await dummyHash);
    const verified = await argon2.verify(hash, input.password).catch(() => false);
    if (!user || !verified || user.memberships.length === 0) {
      throw new ApiException("unauthenticated", GENERIC_LOGIN_ERROR, 401);
    }

    const token = createSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);
    const activeCompany = user.memberships[0].company;
    await this.database.$transaction(async (transaction) => {
      await transaction.session.create({
        data: { tokenHash, userId: user.id, activeCompanyId: activeCompany.id, expiresAt },
      });
      const excessSessions = await transaction.session.findMany({
        where: { userId: user.id, expiresAt: { gt: new Date() } },
        // Más nuevas primero: se conservan las últimas N y se descartan las más antiguas.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: env.SESSION_MAX_PER_USER,
        select: { id: true },
      });
      if (excessSessions.length > 0) {
        await transaction.session.deleteMany({
          where: { id: { in: excessSessions.map(({ id }) => id) }, userId: user.id },
        });
      }
    });

    return {
      token,
      expiresAt,
      payload: this.toPayload(
        user,
        user.memberships.map(({ company }) => company),
        activeCompany,
        user.memberships[0],
      ),
    };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.database.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.database.session.deleteMany({ where: { userId } });
  }

  async getSession(token: string | undefined): Promise<SessionPayload> {
    if (!token) throw this.unauthenticated();
    const session = await this.database.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: {
        user: {
          include: {
            memberships: {
              include: {
                company: true,
                role: { select: { id: true, name: true, isSystem: true, permissions: true } },
              },
              orderBy: { companyId: "asc" },
            },
          },
        },
        activeCompany: true,
      },
    });
    if (!session) throw this.unauthenticated();
    if (session.expiresAt <= new Date()) {
      await this.database.session.deleteMany({ where: { id: session.id } });
      throw this.unauthenticated();
    }
    const membership = session.user.memberships.find(
      ({ companyId }) => companyId === session.activeCompanyId,
    );
    if (!membership) {
      await this.database.session.deleteMany({ where: { id: session.id } });
      throw this.unauthenticated();
    }
    await this.refreshSessionActivity(session.id, session.lastSeenAt);
    return this.toPayload(
      session.user,
      session.user.memberships.map(({ company }) => company),
      session.activeCompany,
      membership,
    );
  }

  async authenticate(token: string | undefined): Promise<SessionContext> {
    if (!token) throw this.unauthenticated();
    const session = await this.database.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: {
        user: {
          include: {
            memberships: {
              select: {
                companyId: true,
                role: { select: { name: true, isSystem: true, permissions: true } },
              },
            },
          },
        },
      },
    });
    if (!session) throw this.unauthenticated();
    if (session.expiresAt <= new Date()) {
      await this.database.session.deleteMany({ where: { id: session.id } });
      throw this.unauthenticated();
    }
    const membership = session.user.memberships.find(
      ({ companyId }) => companyId === session.activeCompanyId,
    );
    if (!membership) {
      await this.database.session.deleteMany({ where: { id: session.id } });
      throw this.unauthenticated();
    }
    await this.refreshSessionActivity(session.id, session.lastSeenAt);
    return {
      userId: session.userId,
      companyId: session.activeCompanyId,
      sessionId: session.id,
      permissions: permissionsForRole(membership.role),
    };
  }

  async setActiveCompany(
    userId: string,
    sessionId: string,
    companyId: string,
  ): Promise<SessionPayload> {
    await this.database.$transaction(
      async (transaction) => {
        const membership = await transaction.membership.findUnique({
          where: { userId_companyId: { userId, companyId } },
          select: { companyId: true },
        });
        if (!membership)
          throw new ApiException("not_found", messageKey("auth.company.notFound"), 404);
        const session = await transaction.session.updateMany({
          where: { id: sessionId, userId, expiresAt: { gt: new Date() } },
          data: { activeCompanyId: companyId },
        });
        if (session.count !== 1) throw this.unauthenticated();
      },
      { isolationLevel: "Serializable" },
    );
    return this.getSessionById(userId, companyId);
  }

  async getSessionById(userId: string, activeCompanyId: string): Promise<SessionPayload> {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: {
            company: true,
            role: { select: { id: true, name: true, isSystem: true, permissions: true } },
          },
          orderBy: { companyId: "asc" },
        },
      },
    });
    const membership = user?.memberships.find(({ companyId }) => companyId === activeCompanyId);
    if (!user || !membership) throw this.unauthenticated();
    return this.toPayload(
      user,
      user.memberships.map(({ company }) => company),
      membership.company,
      membership,
    );
  }

  static cookieName(): string {
    return SESSION_COOKIE;
  }

  private unauthenticated(): ApiException {
    return new ApiException("unauthenticated", messageKey("auth.session.invalid"), 401);
  }

  private async refreshSessionActivity(sessionId: string, lastSeenAt: Date): Promise<void> {
    const now = new Date();
    const idleMinutes = env.SESSION_IDLE_MINUTES;
    if (idleMinutes > 0 && lastSeenAt.getTime() < now.getTime() - idleMinutes * 60_000) {
      await this.database.session.deleteMany({ where: { id: sessionId } });
      throw this.unauthenticated();
    }

    await this.database.session.updateMany({
      where: {
        id: sessionId,
        lastSeenAt: { lt: new Date(now.getTime() - 60_000) },
      },
      data: { lastSeenAt: now },
    });
  }

  private toPayload(
    user: { id: string; email: string; name: string },
    companies: readonly { id: string; legalName: string; name: string }[],
    activeCompany: { id: string; legalName: string; name: string },
    membership: MembershipWithRole,
  ): SessionPayload {
    return {
      user: { id: user.id, email: user.email, name: user.name },
      companies: companies.map(({ id, legalName, name }) => ({ id, legalName, name })),
      activeCompany: {
        id: activeCompany.id,
        legalName: activeCompany.legalName,
        name: activeCompany.name,
      },
      role: { id: membership.role.id, name: membership.role.name },
      permissions: permissionsForRole(membership.role),
    };
  }
}
