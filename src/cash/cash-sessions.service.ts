import { messageKey } from "../common/i18n/index.js";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { ApiException } from "../common/errors.js";
import type { SessionContext } from "../common/request-context.js";
import { DatabaseService } from "../database/database.service.js";
import { toArgentinaIso } from "../common/argentina-time.js";
import { MailOutboxService } from "../notifications/mail-outbox.service.js";
import {
  cashSafeInteger,
  cashSessionSelect,
  mapCashSession,
  type CashSessionDto,
} from "./cash-sessions.mapper.js";
import type { CloseCashSessionInput, OpenCashSessionInput } from "./cash-sessions.schemas.js";
import { calculateCashClose, isCashCloseObservationValid, type CashClose } from "./cash.close.js";
import { CASH_ALERT_RECIPIENTS } from "./cash-alert-recipients.js";

export function validateCashClose(close: CashClose, observation?: string): void {
  if (!isCashCloseObservationValid(close, observation))
    throw new ApiException("business_rule", messageKey("cash.close.observationRequired"), 422, {
      observation: ["cash.close.observationFieldRequired"],
    });
}

export function shouldEnqueueCashClose(close: CashClose, recipients: readonly string[]): boolean {
  return close.difference !== 0 && recipients.length > 0;
}

@Injectable()
export class CashSessionsService {
  private readonly logger = new Logger(CashSessionsService.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly mailOutbox: MailOutboxService,
    @Inject(CASH_ALERT_RECIPIENTS) private readonly recipients: readonly string[],
  ) {}

  async open(session: SessionContext, input: OpenCashSessionInput): Promise<CashSessionDto> {
    try {
      const row = await this.database.cashSession.create({
        data: {
          companyId: session.companyId,
          openedByUserId: session.userId,
          openingBalance: input.openingBalanceCents,
          status: "OPEN",
        },
        select: cashSessionSelect,
      });
      return mapCashSession(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ApiException("conflict", messageKey("cash.session.alreadyOpen"), 409);
      throw error;
    }
  }

  async current(session: SessionContext): Promise<CashSessionDto | null> {
    const row = await this.database.cashSession.findFirst({
      where: { companyId: session.companyId, status: "OPEN" },
      select: cashSessionSelect,
    });
    return row ? mapCashSession(row) : null;
  }

  async close(
    session: SessionContext,
    id: string,
    input: CloseCashSessionInput,
  ): Promise<CashSessionDto> {
    return this.database.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM cash_sessions WHERE id = ${id} AND company_id = ${session.companyId} FOR UPDATE
      `);
      if (!locked.length)
        throw new ApiException("not_found", messageKey("cash.session.notFound"), 404);
      const row = await tx.cashSession.findUniqueOrThrow({
        where: { id_companyId: { id, companyId: session.companyId } },
        select: cashSessionSelect,
      });
      if (row.status === "CLOSED")
        throw new ApiException("conflict", messageKey("cash.session.closed"), 409);
      const collected = await tx.cashMovement.aggregate({
        where: { companyId: session.companyId, sessionId: id, paymentMethod: "CASH" },
        _sum: { amount: true },
      });
      const close = calculateCashClose({
        openingBalance: row.openingBalance,
        cashCollected: cashSafeInteger(collected._sum.amount ?? 0),
        declared: input.declaredBalanceCents,
      });
      validateCashClose(close, input.observation);
      const observation = input.observation?.trim() || null;
      const closedAt = new Date();
      const closed = await tx.cashSession.update({
        where: { id_companyId: { id, companyId: session.companyId } },
        data: {
          status: "CLOSED",
          closedAt,
          closedByUserId: session.userId,
          declaredBalance: BigInt(input.declaredBalanceCents),
          theoreticalBalance: BigInt(close.theoretical),
          difference: BigInt(close.difference),
          observation,
        },
        select: cashSessionSelect,
      });
      if (shouldEnqueueCashClose(close, this.recipients)) {
        const company = await tx.company.findUniqueOrThrow({
          where: { id: session.companyId },
          select: { name: true },
        });
        const user = await tx.user.findUniqueOrThrow({
          where: { id: session.userId },
          select: { name: true, email: true },
        });
        await this.mailOutbox.enqueueCashCloseDifference(tx, {
          companyId: session.companyId,
          sessionId: id,
          data: {
            companyName: company.name,
            differenceCents: close.difference,
            theoreticalCents: close.theoretical,
            declaredCents: input.declaredBalanceCents,
            closedBy: user,
            openedBy: row.openedBy,
            observation: observation ?? "",
            openedAt: toArgentinaIso(row.openedAt),
            closedAt: toArgentinaIso(closedAt),
          },
        });
      } else if (close.difference !== 0 && this.recipients.length === 0) {
        this.logger.warn("Aviso de diferencia omitido: no hay destinatarios configurados.");
      }
      return mapCashSession(closed);
    });
  }
}
