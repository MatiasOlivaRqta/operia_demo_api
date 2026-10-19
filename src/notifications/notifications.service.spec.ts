import { NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../database/database.service.js";
import { NotificationsService } from "./notifications.service.js";

describe("NotificationsService", () => {
  const notification = {
    id: "f21797c2-9a7b-4f94-8924-e6571ef746d1",
    companyId: "company-a",
    type: "ORDER_MESSAGE" as const,
    title: "Pedido de Ana",
    body: "Quiero 3 cajas",
    payload: { chatId: "1" },
    readAt: null,
    createdAt: new Date("2026-10-15T10:00:00.000Z"),
    dedupeKey: "telegram:1:2",
  };
  const model = {
    create: vi.fn(),
    createMany: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  };
  const database = { notification: model } as unknown as DatabaseService;
  const service = new NotificationsService(database);

  beforeEach(() => vi.resetAllMocks());

  it("lists and counts only the active company", async () => {
    model.findMany.mockResolvedValue([notification]);
    model.count.mockResolvedValue(1);
    const page = await service.list("company-a", 1, 20);
    const count = await service.unreadCount("company-a");
    expect(page.items).toEqual([notification]);
    expect(model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: "company-a" } }),
    );
    expect(model.count).toHaveBeenCalledWith({ where: { companyId: "company-a", readAt: null } });
    expect(count).toBe(1);
  });

  it("keeps the original readAt when marking an already read notification", async () => {
    const readAt = new Date("2026-10-14T12:00:00.000Z");
    model.updateMany.mockResolvedValue({ count: 0 });
    model.findFirst.mockResolvedValue({ id: notification.id, readAt });
    await expect(service.markRead("company-a", notification.id)).resolves.toBeUndefined();
    expect(model.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: notification.id, companyId: "company-a", readAt: null },
      }),
    );
  });

  it("returns the existing row without error when the company dedupe key already exists", async () => {
    model.createMany.mockResolvedValue({ count: 0 });
    model.findFirstOrThrow.mockResolvedValue(notification);
    const result = await service.create({
      companyId: "company-a",
      type: "ORDER_MESSAGE",
      title: notification.title,
      body: notification.body,
      payload: notification.payload,
      dedupeKey: notification.dedupeKey,
    });
    expect(result).toEqual({ created: false, notification });
  });

  it("marks a notification from another company as not found", async () => {
    model.updateMany.mockResolvedValue({ count: 0 });
    model.findFirst.mockResolvedValue(null);
    await expect(service.markRead("company-a", notification.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(model.findFirst).toHaveBeenCalledWith({
      where: { id: notification.id, companyId: "company-a" },
      select: { id: true },
    });
  });
});
