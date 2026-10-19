import { Controller, Post, ServiceUnavailableException } from "@nestjs/common";
import { CurrentSession, type SessionContext } from "../common/request-context.js";
import { RequirePermission } from "../permissions/require-permission.decorator.js";
import { TelegramLinkService } from "./telegram-link.service.js";

@Controller("telegram")
export class TelegramController {
  constructor(private readonly links: TelegramLinkService) {}

  @Post("link-token")
  @RequirePermission("users.manage")
  createLink(@CurrentSession() session: SessionContext) {
    if (!this.links.isConfigured()) {
      throw new ServiceUnavailableException("La integración de Telegram no está configurada.");
    }
    return this.links.createLink(session.companyId);
  }
}
