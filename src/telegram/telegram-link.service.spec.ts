import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "../auth/session-token.js";
import type { DatabaseService } from "../database/database.service.js";
import { TelegramLinkService } from "./telegram-link.service.js";

describe("TelegramLinkService", () => {
  const tx = {
    telegramLinkToken: {
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    telegramChat: { upsert: vi.fn() },
  };
  const createToken = vi.fn();
  const database = {
    $transaction: vi.fn((operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx)),
    telegramLinkToken: { create: createToken },
    telegramChat: { findUnique: vi.fn() },
  } as unknown as DatabaseService;
  const service = new TelegramLinkService(database, {
    botToken: "private-token",
    botUsername: "operia_bot",
    pollSeconds: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tx.telegramLinkToken.findUniqueOrThrow.mockResolvedValue({ companyId: "company-a" });
    tx.telegramLinkToken.updateMany.mockResolvedValue({ count: 1 });
    tx.telegramChat.upsert.mockResolvedValue({});
  });

  it("creates a 32-byte base64url token while storing only its hash", async () => {
    const result = await service.createLink("company-a");
    const token = new URL(result.url).searchParams.get("start");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.url).toMatch(/^https:\/\/t\.me\/operia_bot\?start=/);
    expect(createToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: "company-a",
        tokenHash: hashSessionToken(token!),
        expiresAt: expect.any(Date),
      }),
    });
    const expiresAt = (createToken.mock.calls[0]?.[0] as { data: { expiresAt: Date } }).data
      .expiresAt;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(result.expiresAt).toBe(expiresAt.toISOString());
    expect(JSON.stringify(createToken.mock.calls)).not.toContain(token);
  });

  it("consumes a valid token once and upserts the chat in the same transaction", async () => {
    await expect(service.consume("valid-token", "123")).resolves.toEqual({
      ok: true,
      companyId: "company-a",
    });
    expect(tx.telegramLinkToken.updateMany).toHaveBeenCalledWith({
      where: {
        tokenHash: hashSessionToken("valid-token"),
        usedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { usedAt: expect.any(Date) },
    });
    expect(tx.telegramLinkToken.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { tokenHash: hashSessionToken("valid-token") },
      select: { companyId: true },
    });
    expect(tx.telegramChat.upsert).toHaveBeenCalledWith({
      where: { chatId: "123" },
      create: { chatId: "123", companyId: "company-a" },
      update: { companyId: "company-a" },
    });
  });

  it.each(["used", "expired", "nonexistent"])("rejects a %s token", async () => {
    tx.telegramLinkToken.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.consume("invalid-token", "123")).resolves.toEqual({ ok: false });
    expect(tx.telegramLinkToken.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(tx.telegramChat.upsert).not.toHaveBeenCalled();
  });

  it("moves a chat to the company associated with the newly consumed token", async () => {
    tx.telegramLinkToken.findUniqueOrThrow.mockResolvedValue({ companyId: "company-b" });
    await service.consume("company-b-token", "123");
    expect(tx.telegramChat.upsert).toHaveBeenCalledWith({
      where: { chatId: "123" },
      create: { chatId: "123", companyId: "company-b" },
      update: { companyId: "company-b" },
    });
  });

  it("does not bind a chat if a concurrent update already consumed the token", async () => {
    tx.telegramLinkToken.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.consume("raced-token", "123")).resolves.toEqual({ ok: false });
    expect(tx.telegramChat.upsert).not.toHaveBeenCalled();
  });
});
