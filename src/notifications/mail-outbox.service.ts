import { Injectable, Logger } from "@nestjs/common";
import { Prisma, type MailOutbox } from "../generated/prisma/client.js";
import { DatabaseService } from "../database/database.service.js";
import { env } from "../config/env.js";
import { cashCloseEmailDataSchema, type CashCloseEmailData } from "./cash-close-email.js";

const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000] as const;
export function mailBackoffMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError("Invalid attempts");
  return BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
}

export function mailErrorClass(error: unknown): string {
  // Never persist message, stack, code or arbitrary error.name (which may contain PII).
  const name =
    error instanceof Error
      ? (Object.getPrototypeOf(error)?.constructor?.name as unknown)
      : "UnknownError";
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)
    ? name.slice(0, 100)
    : "UnknownError";
}

export type ClaimedMail = Pick<
  MailOutbox,
  "id" | "type" | "recipients" | "payload" | "attempts"
> & { lockedUntil: Date };

@Injectable()
export class MailOutboxService {
  private readonly logger = new Logger(MailOutboxService.name);
  constructor(private readonly database: DatabaseService) {}

  async enqueueCashCloseDifference(
    tx: Prisma.TransactionClient,
    input: {
      companyId: string;
      sessionId: string;
      data: CashCloseEmailData;
    },
  ): Promise<void> {
    const data = cashCloseEmailDataSchema.parse(input.data);
    if (data.differenceCents === 0) return;
    if (env.CASH_ALERT_EMAILS.length === 0) {
      this.logger.warn("Aviso de diferencia omitido: no hay destinatarios configurados.");
      return;
    }
    await tx.mailOutbox.create({
      data: {
        companyId: input.companyId,
        type: "CASH_CLOSE_DIFFERENCE",
        notificationKey: `cash-close:${input.sessionId}`,
        recipients: [...env.CASH_ALERT_EMAILS],
        payload: data,
      },
    });
  }

  async takeDueBatch(limit = 10): Promise<ClaimedMail[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError("Invalid batch size");
    return this.database.$transaction(async (tx) => {
      // Sending is sequential and bounded by SMTP timeouts; 10 rows fit within this lease.
      return tx.$queryRaw<ClaimedMail[]>(Prisma.sql`
        WITH due AS (
          SELECT id FROM mail_outbox
          WHERE status = 'P' AND next_attempt_at <= now()
            AND (locked_until IS NULL OR locked_until <= now())
          ORDER BY next_attempt_at, created_at, id
          LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        UPDATE mail_outbox m
        SET locked_until = now() + interval '10 minutes', attempts = m.attempts + 1
        FROM due WHERE m.id = due.id
        RETURNING m.id, m.type, m.recipients, m.payload, m.attempts, m.locked_until AS "lockedUntil"
      `);
    });
  }

  async markSent(mail: ClaimedMail): Promise<void> {
    await this.database.mailOutbox.updateMany({
      where: {
        id: mail.id,
        status: "PENDING",
        lockedUntil: mail.lockedUntil,
        attempts: mail.attempts,
      },
      data: { status: "SENT", sentAt: new Date(), lockedUntil: null, lastError: null },
    });
  }

  async reschedule(mail: ClaimedMail, error: unknown): Promise<void> {
    if (mail.attempts >= env.MAIL_MAX_ATTEMPTS) return this.markFailed(mail, error);
    await this.database.mailOutbox.updateMany({
      where: {
        id: mail.id,
        status: "PENDING",
        lockedUntil: mail.lockedUntil,
        attempts: mail.attempts,
      },
      data: {
        nextAttemptAt: new Date(Date.now() + mailBackoffMs(mail.attempts)),
        lockedUntil: null,
        lastError: mailErrorClass(error),
      },
    });
  }

  async markFailed(mail: ClaimedMail, error: unknown): Promise<void> {
    await this.database.mailOutbox.updateMany({
      where: {
        id: mail.id,
        status: "PENDING",
        lockedUntil: mail.lockedUntil,
        attempts: mail.attempts,
      },
      data: { status: "FAILED", lockedUntil: null, lastError: mailErrorClass(error) },
    });
  }
}
