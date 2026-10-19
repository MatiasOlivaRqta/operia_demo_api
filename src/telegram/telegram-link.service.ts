import { Injectable, Inject } from "@nestjs/common";
import { createSessionToken, hashSessionToken } from "../auth/session-token.js";
import { DatabaseService } from "../database/database.service.js";
import { TELEGRAM_SETTINGS, type TelegramSettings } from "./telegram.config.js";

const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class TelegramLinkService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(TELEGRAM_SETTINGS) private readonly settings: TelegramSettings,
  ) {}

  isConfigured(): boolean {
    return (
      this.settings.pollSeconds > 0 && Boolean(this.settings.botToken && this.settings.botUsername)
    );
  }

  async createLink(companyId: string): Promise<{ url: string; expiresAt: string }> {
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);
    await this.database.telegramLinkToken.create({
      data: { companyId, tokenHash: hashSessionToken(token), expiresAt },
    });
    return {
      url: `https://t.me/${this.settings.botUsername}?start=${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async consume(
    token: string,
    chatId: string,
  ): Promise<{ ok: false } | { ok: true; companyId: string }> {
    const tokenHash = hashSessionToken(token);
    return this.database.$transaction(async (transaction) => {
      const consumed = await transaction.telegramLinkToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (consumed.count === 0) return { ok: false };
      const link = await transaction.telegramLinkToken.findUniqueOrThrow({
        where: { tokenHash },
        select: { companyId: true },
      });

      await transaction.telegramChat.upsert({
        where: { chatId },
        create: { chatId, companyId: link.companyId },
        update: { companyId: link.companyId },
      });
      return { ok: true, companyId: link.companyId };
    });
  }

  async consumeToken(token: string, chatId: string): Promise<boolean> {
    return (await this.consume(token, chatId)).ok;
  }

  async getCompanyId(chatId: string): Promise<string | null> {
    const chat = await this.database.telegramChat.findUnique({
      where: { chatId },
      select: { companyId: true },
    });
    return chat?.companyId ?? null;
  }
}
