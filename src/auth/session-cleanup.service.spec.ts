import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../config/env.js";
import type { DatabaseService } from "../database/database.service.js";
import { SessionCleanupService } from "./session-cleanup.service.js";

describe("SessionCleanupService", () => {
  const originalIdleMinutes = env.SESSION_IDLE_MINUTES;

  afterEach(() => {
    env.SESSION_IDLE_MINUTES = originalIdleMinutes;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("deletes expired and inactive sessions while preserving active sessions", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-19T12:00:00.000Z");
    vi.setSystemTime(now);
    env.SESSION_IDLE_MINUTES = 60;
    const database = { session: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) } };
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const service = new SessionCleanupService(database as unknown as DatabaseService);

    await service.purgeExpired();

    expect(database.session.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { expiresAt: { lte: now } },
          { lastSeenAt: { lt: new Date(now.getTime() - 60 * 60_000) } },
        ],
      },
    });
    expect(log).toHaveBeenCalledWith("Deleted 3 expired sessions");
  });

  it("only deletes expired sessions when inactivity expiration is disabled", async () => {
    env.SESSION_IDLE_MINUTES = 0;
    const database = { session: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    const service = new SessionCleanupService(database as unknown as DatabaseService);

    await service.purgeExpired();

    expect(database.session.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: expect.any(Date) } },
    });
  });

  it("does not start the cleanup timer when the interval is zero", () => {
    const database = { session: { deleteMany: vi.fn() } };
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const service = new SessionCleanupService(database as unknown as DatabaseService);

    service.onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
