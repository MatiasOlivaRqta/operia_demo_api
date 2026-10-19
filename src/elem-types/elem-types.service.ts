import { messageKey } from "../common/i18n/index.js";
import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { ApiException } from "../common/errors.js";
import { paginate, type Page } from "../common/pagination.js";
import type { SessionContext } from "../common/request-context.js";
import { normalizeSearch } from "../common/search.js";
import { DatabaseService } from "../database/database.service.js";
import type { SubTypeInput, SubTypeQuery } from "./elem-type.schemas.js";

export type SubTypeDto = { id: string; elemTypeId: string; description: string };

const subTypeSelect = { id: true, elemTypeId: true, description: true } as const;

// Misma normalización que usa la migración (minúsculas, sin tildes) más espacios internos compactados.
export function normalizeDescription(value: string): string {
  return normalizeSearch(value).replaceAll(/\s+/g, " ");
}

@Injectable()
export class ElemTypesService {
  constructor(private readonly database: DatabaseService) {}

  async listSubTypes(
    session: SessionContext,
    typeId: string,
    query: SubTypeQuery,
  ): Promise<Page<SubTypeDto>> {
    await this.requireType(typeId);
    const term = normalizeDescription(query.search ?? "");
    const escaped = term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const where: Prisma.ElemSubTypeWhereInput = {
      companyId: session.companyId,
      elemTypeId: typeId,
      ...(term ? { descriptionNormalized: { contains: escaped } } : {}),
    };
    const { skip, take } = paginate(query.page, query.pageSize);
    const [items, total] = await Promise.all([
      this.database.elemSubType.findMany({
        where,
        orderBy: [{ descriptionNormalized: "asc" }, { id: "asc" }],
        skip,
        take,
        select: subTypeSelect,
      }),
      this.database.elemSubType.count({ where }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async createSubType(
    session: SessionContext,
    typeId: string,
    input: SubTypeInput,
  ): Promise<{ created: boolean; subType: SubTypeDto }> {
    await this.requireType(typeId);
    const descriptionNormalized = normalizeDescription(input.description);
    const key = { companyId: session.companyId, elemTypeId: typeId, descriptionNormalized };
    const find = () =>
      this.database.elemSubType.findUnique({
        where: { companyId_elemTypeId_descriptionNormalized: key },
        select: subTypeSelect,
      });
    const existing = await find();
    if (existing) return { created: false, subType: existing };
    try {
      const subType = await this.database.elemSubType.create({
        data: { ...key, description: input.description },
        select: subTypeSelect,
      });
      return { created: true, subType };
    } catch (error: unknown) {
      // Carrera por el índice único: otro pedido creó la misma categoría, se devuelve esa.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await find();
        if (winner) return { created: false, subType: winner };
      }
      throw error;
    }
  }

  private async requireType(typeId: string): Promise<void> {
    const type = await this.database.elemType.findUnique({
      where: { id: typeId },
      select: { id: true },
    });
    if (!type) throw new ApiException("not_found", messageKey("catalogType.notFound"), 404);
  }
}
