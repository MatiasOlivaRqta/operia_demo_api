import { Module } from "@nestjs/common";
import { CashController } from "./cash.controller.js";
import { CashService } from "./cash.service.js";
import { CashSessionsService } from "./cash-sessions.service.js";
import { env } from "../config/env.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { CASH_ALERT_RECIPIENTS } from "./cash-alert-recipients.js";
import { CustomerAccountModule } from "../customer-account/customer-account.module.js";
import { CashCollectionsService } from "./cash-collections.service.js";

@Module({
  imports: [NotificationsModule, CustomerAccountModule],
  controllers: [CashController],
  providers: [
    CashService,
    CashSessionsService,
    CashCollectionsService,
    { provide: CASH_ALERT_RECIPIENTS, useFactory: (): readonly string[] => env.CASH_ALERT_EMAILS },
  ],
})
export class CashModule {}
