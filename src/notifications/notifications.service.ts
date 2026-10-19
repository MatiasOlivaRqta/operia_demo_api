import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Notification, type NotificationType } from "../generated/prisma/client.js";
import { paginate, type Page } from "../common/pagination.js";
import { DatabaseService } from "../database/database.service.js";

export type CreateNotificationInput = {
  companyId: string;
  type: NotificationType;
  title: string;
  body: string;
  payload: Prisma.InputJsonValue;
  dedupeKey?: string;
};

export type NotificationPageItem = Pick<
  Notification,
  "id" | "type" | "title" | "body" | "payload" | "readAt" | "createdAt"
>;

@Injectable()
export class NotificationsService {
  constructor(private readonly database: DatabaseService) {}

  async create(
    input: CreateNotificationInput,
  ): Promise<{ created: boolean; notification: Notification }> {
    if (!input.dedupeKey) {
      const notification = await this.database.notification.create({ data: input });
      return { created: true, notification };
    }

    const { dedupeKey, ...data } = input;
    const result = await this.database.notification.createMany({
      data: [{ ...data, dedupeKey }],
      skipDuplicates: true,
    });
    const notification = await this.database.notification.findFirstOrThrow({
      where: { companyId: input.companyId, dedupeKey },
    });
    return { created: result.count === 1, notification };
  }

  async list(
    companyId: string,
    page: number,
    pageSize: number,
  ): Promise<Page<NotificationPageItem>> {
    const where = { companyId };
    const { skip, take } = paginate(page, pageSize);
    const [items, total] = await Promise.all([
      this.database.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          payload: true,
          readAt: true,
          createdAt: true,
        },
      }),
      this.database.notification.count({ where }),
    ]);
    return { items, page, pageSize, total };
  }

  unreadCount(companyId: string): Promise<number> {
    return this.database.notification.count({ where: { companyId, readAt: null } });
  }

  async markRead(companyId: string, id: string): Promise<void> {
    const result = await this.database.notification.updateMany({
      where: { id, companyId, readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count > 0) return;

    const existing = await this.database.notification.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Notificación no encontrada.");
  }

  async markAllRead(companyId: string): Promise<number> {
    const result = await this.database.notification.updateMany({
      where: { companyId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }
}
