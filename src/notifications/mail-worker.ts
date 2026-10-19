import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { env } from "../config/env.js";
import { cashCloseEmailDataSchema, renderCashCloseDifferenceEmail } from "./cash-close-email.js";
import { MailOutboxService, mailErrorClass } from "./mail-outbox.service.js";
import { MAIL_TRANSPORT, type MailTransport } from "./mail-transport.js";

@Injectable()
export class MailWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailWorker.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private processing: Promise<void> | undefined;
  constructor(
    private readonly outbox: MailOutboxService,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  onModuleInit(): void {
    if (env.MAIL_POLL_SECONDS === 0) return;
    this.timer = setInterval(() => {
      void this.processDue().catch((error: unknown) =>
        this.logger.warn(`Mail worker: ${mailErrorClass(error)}`),
      );
    }, env.MAIL_POLL_SECONDS * 1000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.processing;
  }

  processDue(): Promise<void> {
    if (this.processing) return this.processing;
    this.processing = this.processBatch().finally(() => {
      this.processing = undefined;
    });
    return this.processing;
  }

  private async processBatch(): Promise<void> {
    const batch = await this.outbox.takeDueBatch();
    for (const mail of batch) {
      try {
        if (mail.attempts > env.MAIL_MAX_ATTEMPTS) {
          await this.outbox.markFailed(mail, new Error("Attempt limit reached"));
          continue;
        }
        const data = cashCloseEmailDataSchema.parse(mail.payload);
        await this.transport.send({
          ...renderCashCloseDifferenceEmail(data),
          recipients: mail.recipients,
        });
        await this.outbox.markSent(mail);
      } catch (error: unknown) {
        await this.outbox.reschedule(mail, error);
      }
    }
  }
}
