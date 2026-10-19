import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { NotificationsService } from "../notifications/notifications.service.js";
import { TELEGRAM_SETTINGS, type TelegramSettings } from "./telegram.config.js";
import { TelegramLinkService } from "./telegram-link.service.js";
import {
  telegramGetUpdatesResponseSchema,
  telegramUpdateSchema,
  type TelegramUpdate,
} from "./telegram.schemas.js";

const MAX_MESSAGE_LENGTH = 1000;
const MAX_MESSAGES_PER_MINUTE = 10;
const MESSAGE_WINDOW_MS = 60_000;
const TELEGRAM_LONG_POLL_SECONDS = 25;

@Injectable()
export class TelegramBot implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBot.name);
  private offset = 0;
  private running = false;
  private loop: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private finishRetryWait: (() => void) | undefined;
  private readonly messagesByChat = new Map<string, number[]>();
  private readonly rateLimitWarned = new Set<string>();

  constructor(
    @Inject(TELEGRAM_SETTINGS) private readonly settings: TelegramSettings,
    private readonly links: TelegramLinkService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (this.settings.pollSeconds === 0 || !this.settings.botToken) return;
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.finishRetryWait?.();
    await this.loop;
  }

  async pollOnce(): Promise<void> {
    if (this.settings.pollSeconds === 0 || !this.settings.botToken) return;
    const response = await fetch(this.apiUrl("getUpdates"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset: this.offset, timeout: TELEGRAM_LONG_POLL_SECONDS }),
      signal: this.controller?.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const parsed = telegramGetUpdatesResponseSchema.parse(payload);
    for (const update of parsed.result) {
      const validatedUpdate = telegramUpdateSchema.safeParse(update);
      if (!validatedUpdate.success) {
        this.logger.warn(`Telegram update skipped: ${errorClass(validatedUpdate.error)}`);
        this.offset = update.update_id + 1;
        continue;
      }
      await this.handleUpdate(validatedUpdate.data);
      this.offset = update.update_id + 1;
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || message.chat.type !== "private") return;
    const chatId = String(message.chat.id);
    const text = message.text;
    const startMatch = text?.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{43})\s*$/);
    if (startMatch) {
      const linked = await this.links.consumeToken(startMatch[1]!, chatId);
      await this.sendMessage(
        chatId,
        linked
          ? "Chat vinculado. Ya podés enviar tus pedidos por este chat."
          : "El link de vinculación no es válido o venció. Pedí uno nuevo desde Operia.",
      );
      return;
    }
    if (text?.trim().match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/)) {
      await this.sendMessage(
        chatId,
        "No me llegó el código de vinculación. Copialo desde Operia (campana > Vincular Telegram) y pegalo acá.",
      );
      return;
    }

    const companyId = await this.lookupLinkedCompany(chatId);
    const pastedToken = text?.trim().match(/^[A-Za-z0-9_-]{43}$/);
    if (!companyId && pastedToken) {
      const linked = await this.links.consumeToken(pastedToken[0], chatId);
      await this.sendMessage(
        chatId,
        linked
          ? "Chat vinculado. Ya podés enviar tus pedidos por este chat."
          : "El link de vinculación no es válido o venció. Pedí uno nuevo desde Operia.",
      );
      return;
    }
    if (!companyId) {
      await this.sendMessage(chatId, "Vinculá este chat desde Operia antes de enviar pedidos.");
      return;
    }
    if (!text) {
      await this.sendMessage(chatId, "Solo puedo registrar pedidos enviados como texto.");
      return;
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      await this.sendMessage(chatId, "El mensaje supera el límite de 1000 caracteres.");
      return;
    }
    if (!this.allowMessage(chatId)) return;

    const sender = message.from;
    const name =
      [sender?.first_name, sender?.last_name].filter(Boolean).join(" ") ||
      sender?.username ||
      "cliente";
    await this.notifications.create({
      companyId,
      type: "ORDER_MESSAGE",
      title: `Pedido de ${name}`,
      body: text,
      payload: {
        chatId,
        messageId: message.message_id,
        username: sender?.username ?? null,
      },
      dedupeKey: `telegram:${chatId}:${message.message_id}`,
    });
    await this.sendMessage(chatId, "Recibimos tu pedido. ¡Gracias!");
  }

  private allowMessage(chatId: string): boolean {
    const now = Date.now();
    const timestamps = (this.messagesByChat.get(chatId) ?? []).filter(
      (timestamp) => now - timestamp < MESSAGE_WINDOW_MS,
    );
    if (timestamps.length >= MAX_MESSAGES_PER_MINUTE) {
      this.messagesByChat.set(chatId, timestamps);
      if (!this.rateLimitWarned.has(chatId)) {
        this.rateLimitWarned.add(chatId);
        void this.sendMessage(
          chatId,
          "Llegaste al límite de 10 mensajes por minuto. Esperá un momento.",
        );
      }
      return false;
    }
    timestamps.push(now);
    this.messagesByChat.set(chatId, timestamps);
    if (timestamps.length === 1) this.rateLimitWarned.delete(chatId);
    return true;
  }

  private async lookupLinkedCompany(chatId: string): Promise<string | null> {
    return this.links.getCompanyId(chatId);
  }

  private async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      const response = await fetch(this.apiUrl("sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error: unknown) {
      this.logger.warn(`Telegram sendMessage failed: ${errorClass(error)}`);
    }
  }

  private apiUrl(method: "getUpdates" | "sendMessage"): string {
    return `https://api.telegram.org/bot${this.settings.botToken}/${method}`;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        this.controller = new AbortController();
        await this.pollOnce();
      } catch (error: unknown) {
        if (this.running) this.logger.warn(`Telegram polling failed: ${errorClass(error)}`);
        if (this.running) await this.waitBeforeRetry();
      } finally {
        this.controller = undefined;
      }
    }
  }

  private waitBeforeRetry(): Promise<void> {
    return new Promise((resolve) => {
      this.finishRetryWait = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.finishRetryWait = undefined;
        resolve();
      }, this.settings.pollSeconds * 1000);
      this.retryTimer.unref();
    });
  }
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
