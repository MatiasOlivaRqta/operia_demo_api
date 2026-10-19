import { Module } from "@nestjs/common";
import { MailOutboxService } from "./mail-outbox.service.js";
import { MailWorker } from "./mail-worker.js";
import { MAIL_TRANSPORT } from "./mail-transport.js";
import { NodemailerTransport } from "./nodemailer-transport.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MailOutboxService,
    MailWorker,
    { provide: MAIL_TRANSPORT, useClass: NodemailerTransport },
  ],
  exports: [MailOutboxService, NotificationsService],
})
export class NotificationsModule {}
