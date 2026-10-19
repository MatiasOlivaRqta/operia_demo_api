import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../config/env.js";
import type { DatabaseService } from "../database/database.service.js";
import { AuthService } from "./auth.service.js";

const now = new Date("2026-10-19T12:00:00.000Z");

describe("AuthService session inactivity", () => {
  const originalIdleMinutes = env.SESSION_IDLE_MINUTES;

  afterEach(() => {
    env.SESSION_IDLE_MINUTES = originalIdleMinutes;
    vi.useRealTimers();
  });

  it("deletes an inactive session and rejects it from getSession", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    env.SESSION_IDLE_MINUTES = 60;
    const database = createDatabase({ lastSeenAt: new Date(now.getTime() - 60 * 60_000 - 1) });
    const service = new AuthService(database as unknown as DatabaseService);

    await expect(service.getSession("session-token")).rejects.toMatchObject({
      code: "unauthenticated",
      status: 401,
    });

    expect(database.session.deleteMany).toHaveBeenCalledWith({ where: { id: "session-id" } });
    expect(database.session.updateMany).not.toHaveBeenCalled();
  });

  it("refreshes lastSeenAt for an active session after the 60 second throttle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    env.SESSION_IDLE_MINUTES = 60;
    const database = createDatabase({ lastSeenAt: new Date(now.getTime() - 2 * 60_000) });
    const service = new AuthService(database as unknown as DatabaseService);

    await expect(service.authenticate("session-token")).resolves.toMatchObject({
      userId: "user-id",
      sessionId: "session-id",
    });

    expect(database.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: "session-id",
        lastSeenAt: { lt: new Date(now.getTime() - 60_000) },
      },
      data: { lastSeenAt: now },
    });
    expect(database.session.deleteMany).not.toHaveBeenCalled();
  });

  it("does not refresh a recently recorded session within the 60 second throttle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    env.SESSION_IDLE_MINUTES = 60;
    const database = createDatabase({ lastSeenAt: new Date(now.getTime() - 30_000) });
    const service = new AuthService(database as unknown as DatabaseService);

    await expect(service.authenticate("session-token")).resolves.toMatchObject({
      sessionId: "session-id",
    });

    expect(database.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: "session-id",
        lastSeenAt: { lt: new Date(now.getTime() - 60_000) },
      },
      data: { lastSeenAt: now },
    });
    expect(database.session.deleteMany).not.toHaveBeenCalled();
  });

  it("does not expire sessions when inactivity is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    env.SESSION_IDLE_MINUTES = 0;
    const database = createDatabase({ lastSeenAt: new Date(now.getTime() - 24 * 60 * 60_000) });
    const service = new AuthService(database as unknown as DatabaseService);

    await expect(service.authenticate("session-token")).resolves.toMatchObject({
      sessionId: "session-id",
    });

    expect(database.session.deleteMany).not.toHaveBeenCalled();
    expect(database.session.updateMany).toHaveBeenCalled();
  });
});

describe("AuthService.logoutAll", () => {
  it("deletes sessions scoped to the requested user", async () => {
    const database = {
      session: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    const service = new AuthService(database as unknown as DatabaseService);

    await service.logoutAll("user-id");

    expect(database.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-id" } });
  });
});

function createDatabase({ lastSeenAt }: { lastSeenAt: Date }) {
  const membership = {
    companyId: "company-id",
    company: { id: "company-id", legalName: "Company", name: "Company" },
    role: { id: "role-id", name: "ADMIN", isSystem: true, permissions: [] as string[] },
  };
  return {
    session: {
      findUnique: vi.fn().mockResolvedValue({
        id: "session-id",
        tokenHash: "token-hash",
        userId: "user-id",
        activeCompanyId: "company-id",
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        createdAt: now,
        lastSeenAt,
        user: {
          id: "user-id",
          email: "user@example.com",
          name: "User",
          memberships: [membership],
        },
        activeCompany: membership.company,
      }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}
