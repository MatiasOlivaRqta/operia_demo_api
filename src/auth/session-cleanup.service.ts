import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { env } from "../config/env.js";
import { DatabaseService } from "../database/database.service.js";

@Injectable()
export class SessionCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionCleanupService.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    if (env.SESSION_CLEANUP_MINUTES === 0) return;
    this.timer = setInterval(() => {
      void this.purgeExpired().catch(() => this.logger.error("Session cleanup failed"));
    }, env.SESSION_CLEANUP_MINUTES * 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async purgeExpired(): Promise<void> {
    const now = new Date();
    const where =
      env.SESSION_IDLE_MINUTES > 0
        ? {
            OR: [
              { expiresAt: { lte: now } },
              {
                lastSeenAt: {
                  lt: new Date(now.getTime() - env.SESSION_IDLE_MINUTES * 60_000),
                },
              },
            ],
          }
        : { expiresAt: { lte: now } };
    const result = await this.database.session.deleteMany({
      where,
    });
    this.logger.log(`Deleted ${result.count} expired sessions`);
  }
}
