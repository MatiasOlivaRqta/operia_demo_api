import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { NotificationsService } from "../notifications/notifications.service.js";
import { TelegramBot } from "./telegram-bot.js";
import type { TelegramLinkService } from "./telegram-link.service.js";

describe("TelegramBot", () => {
  const settings = { botToken: "secret-bot-token", botUsername: "operia_bot", pollSeconds: 1 };
  const links = {
    consumeToken: vi.fn(),
    getCompanyId: vi.fn(),
  } as unknown as TelegramLinkService;
  const notifications = { create: vi.fn() } as unknown as NotificationsService;
  const bot = new TelegramBot(settings, links, notifications);
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(links.consumeToken).mockResolvedValue(true);
    vi.mocked(links.getCompanyId).mockResolvedValue("company-a");
    vi.mocked(notifications.create).mockResolvedValue({
      created: true,
      notification: {} as never,
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("advances the in-memory offset after handling each update", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 41,
              message: { message_id: 1, chat: { id: 8, type: "private" }, text: "pedido" },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await bot.pollOnce();
    await bot.pollOnce();
    const polls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/getUpdates"));
    const first = JSON.parse(String(polls[0]?.[1]?.body)) as { offset: number };
    const second = JSON.parse(String(polls[1]?.[1]?.body)) as { offset: number };
    expect(first.offset).toBe(0);
    expect(second.offset).toBe(42);
  });

  it("skips a malformed update, advances past it, and handles the next update", async () => {
    const logger = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            { update_id: 50, message: { message_id: 1, chat: { id: 8 }, text: "malformed" } },
            {
              update_id: 51,
              message: {
                message_id: 2,
                chat: { id: 8, type: "private" },
                text: "pedido válido",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await bot.pollOnce();
    await bot.pollOnce();

    const polls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/getUpdates"));
    const second = JSON.parse(String(polls[1]?.[1]?.body)) as { offset: number };
    expect(second.offset).toBe(52);
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith("Telegram update skipped: ZodError");
    expect(logger.mock.calls.flat().join(" ")).not.toContain(settings.botToken);
    logger.mockRestore();
  });

  it("does not advance the offset when handling an update fails", async () => {
    vi.mocked(notifications.create)
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ created: true, notification: {} as never });
    const update = {
      update_id: 61,
      message: { message_id: 9, chat: { id: 9, type: "private" }, text: "pedido" },
    };
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: [update] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: [update] }), { status: 200 }),
      );

    await expect(bot.pollOnce()).rejects.toThrow("database unavailable");
    await bot.pollOnce();

    const polls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/getUpdates"));
    const first = JSON.parse(String(polls[0]?.[1]?.body)) as { offset: number };
    const second = JSON.parse(String(polls[1]?.[1]?.body)) as { offset: number };
    expect(first.offset).toBe(second.offset);
    expect(notifications.create).toHaveBeenCalledTimes(2);
  });

  it("creates an order notification for a linked private text message", async () => {
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 17,
        chat: { id: 123, type: "private" },
        from: { first_name: "Ana", last_name: "Pérez", username: "ana" },
        text: "Quiero 3 cajas de X",
      },
    });
    expect(notifications.create).toHaveBeenCalledWith({
      companyId: "company-a",
      type: "ORDER_MESSAGE",
      title: "Pedido de Ana Pérez",
      body: "Quiero 3 cajas de X",
      payload: { chatId: "123", messageId: 17, username: "ana" },
      dedupeKey: "telegram:123:17",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/sendMessage$/),
      expect.objectContaining({ body: expect.stringContaining("Recibimos tu pedido") }),
    );
  });

  it("keeps the notification when the confirmation send fails and logs no bot token", async () => {
    const logger = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    fetchMock.mockRejectedValueOnce(new Error(`network failure ${settings.botToken}`));
    await bot.handleUpdate({
      update_id: 9,
      message: { message_id: 9, chat: { id: 1234, type: "private" }, text: "pedido" },
    });
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls.flat().join(" ")).not.toContain(settings.botToken);
    logger.mockRestore();
  });

  it("uses the same idempotency key when an update is delivered twice", async () => {
    const persisted = new Map<string, unknown>();
    vi.mocked(notifications.create).mockImplementation(async (input) => {
      const existing = persisted.get(input.dedupeKey ?? "");
      if (existing) return { created: false, notification: existing as never };
      const notification = { dedupeKey: input.dedupeKey } as never;
      persisted.set(input.dedupeKey ?? "", notification);
      return { created: true, notification };
    });
    const update = {
      update_id: 5,
      message: { message_id: 19, chat: { id: 123, type: "private" }, text: "pedido" },
    };
    await bot.handleUpdate(update);
    await bot.handleUpdate(update);
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(persisted.size).toBe(1);
    expect(notifications.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ dedupeKey: "telegram:123:19" }),
    );
    expect(notifications.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ dedupeKey: "telegram:123:19" }),
    );
  });

  it("instructs an unlinked chat without creating a notification", async () => {
    vi.mocked(links.getCompanyId).mockResolvedValue(null);
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 4, type: "private" }, text: "hola" },
    });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/sendMessage$/),
      expect.objectContaining({ body: expect.stringContaining("Vinculá este chat") }),
    );
  });

  it("rejects groups, non-text messages, and messages longer than 1000 characters", async () => {
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 4, type: "group" }, text: "hola" },
    });
    await bot.handleUpdate({
      update_id: 2,
      message: { message_id: 2, chat: { id: 4, type: "private" } },
    });
    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 3, chat: { id: 4, type: "private" }, text: "x".repeat(1001) },
    });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const responses = fetchMock.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)) as { text: string },
    );
    expect(responses.map((response) => response.text)).toEqual([
      "Solo puedo registrar pedidos enviados como texto.",
      "El mensaje supera el límite de 1000 caracteres.",
    ]);
  });

  it("consumes start tokens and responds for valid and invalid tokens", async () => {
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 4, type: "private" },
        text: `/start ${"a".repeat(43)}`,
      },
    });
    vi.mocked(links.consumeToken).mockResolvedValue(false);
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        chat: { id: 4, type: "private" },
        text: `/start ${"b".repeat(43)}`,
      },
    });
    expect(links.consumeToken).toHaveBeenCalledTimes(2);
    expect(notifications.create).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const responses = fetchMock.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)) as { text: string },
    );
    expect(responses.map((response) => response.text)).toEqual([
      "Chat vinculado. Ya podés enviar tus pedidos por este chat.",
      "El link de vinculación no es válido o venció. Pedí uno nuevo desde Operia.",
    ]);
  });

  it("links an unlinked chat when a valid code is pasted", async () => {
    vi.mocked(links.getCompanyId).mockResolvedValue(null);
    const token = "a".repeat(43);
    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 3, chat: { id: 4, type: "private" }, text: ` ${token} ` },
    });

    expect(links.consumeToken).toHaveBeenCalledWith(token, "4");
    expect(notifications.create).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/sendMessage$/),
      expect.objectContaining({ body: expect.stringContaining("Chat vinculado") }),
    );
  });

  it.each(["invalid", "used", "expired"])(
    "replies that a pasted %s code is invalid or expired",
    async () => {
      vi.mocked(links.getCompanyId).mockResolvedValue(null);
      vi.mocked(links.consumeToken).mockResolvedValue(false);
      await bot.handleUpdate({
        update_id: 4,
        message: {
          message_id: 4,
          chat: { id: 4, type: "private" },
          text: "z".repeat(43),
        },
      });

      expect(links.consumeToken).toHaveBeenCalledWith("z".repeat(43), "4");
      expect(notifications.create).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/sendMessage$/),
        expect.objectContaining({
          body: expect.stringContaining("no es válido o venció"),
        }),
      );
    },
  );

  it("treats a pasted code from a linked chat as an order without consuming it", async () => {
    const token = "a".repeat(43);
    await bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 5,
        chat: { id: 4, type: "private" },
        text: token,
      },
    });

    expect(links.getCompanyId).toHaveBeenCalledWith("4");
    expect(links.consumeToken).not.toHaveBeenCalled();
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "company-a", body: token }),
    );
  });

  it("gives copy instructions for /start without a valid code", async () => {
    for (const text of ["/start", "/start invalid"]) {
      await bot.handleUpdate({
        update_id: 6,
        message: { message_id: 6, chat: { id: 4, type: "private" }, text },
      });
    }

    expect(links.consumeToken).not.toHaveBeenCalled();
    const responses = fetchMock.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)) as { text: string },
    );
    expect(responses.map((response) => response.text)).toEqual([
      "No me llegó el código de vinculación. Copialo desde Operia (campana > Vincular Telegram) y pegalo acá.",
      "No me llegó el código de vinculación. Copialo desde Operia (campana > Vincular Telegram) y pegalo acá.",
    ]);
  });

  it("limits each chat to 10 messages per minute and sends only one limit warning", async () => {
    for (let messageId = 1; messageId <= 12; messageId += 1) {
      await bot.handleUpdate({
        update_id: messageId,
        message: { message_id: messageId, chat: { id: 999, type: "private" }, text: "pedido" },
      });
    }
    expect(notifications.create).toHaveBeenCalledTimes(10);
    const rateWarnings = fetchMock.mock.calls.filter((call) =>
      String(call[1]?.body).includes("límite de 10 mensajes"),
    );
    expect(rateWarnings).toHaveLength(1);
    expect(String(rateWarnings[0]?.[1]?.body)).toContain(
      "Llegaste al límite de 10 mensajes por minuto. Esperá un momento.",
    );
  });

  it("keeps retry errors free of the bot token and retries after a failed poll", async () => {
    vi.useFakeTimers();
    const logger = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const retryBot = new TelegramBot(settings, links, notifications);
    fetchMock.mockRejectedValueOnce(new Error(`network failure for ${settings.botToken}`));
    fetchMock.mockImplementationOnce(() => {
      void retryBot.onModuleDestroy();
      return Promise.reject(new Error(`network failure for ${settings.botToken}`));
    });
    retryBot.onModuleInit();
    await vi.waitFor(() => expect(logger).toHaveBeenCalled());
    expect(logger.mock.calls.flat().join(" ")).not.toContain(settings.botToken);
    await vi.advanceTimersByTimeAsync(1000);
    await retryBot.onModuleDestroy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    logger.mockRestore();
    vi.useRealTimers();
  });

  it("does not poll when the interval is zero or the token is empty", async () => {
    const disabledByInterval = new TelegramBot(
      { ...settings, pollSeconds: 0 },
      links,
      notifications,
    );
    const disabledByToken = new TelegramBot({ ...settings, botToken: "" }, links, notifications);
    disabledByInterval.onModuleInit();
    disabledByToken.onModuleInit();
    await disabledByInterval.pollOnce();
    await disabledByToken.pollOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    await disabledByInterval.onModuleDestroy();
    await disabledByToken.onModuleDestroy();
  });
});
