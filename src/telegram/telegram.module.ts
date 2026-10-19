import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { TelegramBot } from "./telegram-bot.js";
import { TelegramController } from "./telegram.controller.js";
import { TELEGRAM_SETTINGS, telegramSettings } from "./telegram.config.js";
import { TelegramLinkService } from "./telegram-link.service.js";

@Module({
  imports: [NotificationsModule],
  controllers: [TelegramController],
  providers: [
    TelegramLinkService,
    TelegramBot,
    { provide: TELEGRAM_SETTINGS, useValue: telegramSettings },
  ],
  exports: [TelegramLinkService],
})
export class TelegramModule {}
