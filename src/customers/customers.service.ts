import { messageKey } from "../common/i18n/index.js";
import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { ApiException } from "../common/errors.js";
import { paginate, type Page } from "../common/pagination.js";
import { normalizeSearch } from "../common/search.js";
import { DatabaseService } from "../database/database.service.js";
import type { SessionContext } from "../common/request-context.js";
import type { CustomerInput, CustomerQuery } from "./customer.schemas.js";
import {
  mapCustomerCreateInputToPersistence,
  mapCustomerInputToPersistence,
  mapCustomerToDto,
} from "./customer.mapper.js";
import type { CustomerDto, CustomerListItemDto } from "./customer.mapper.js";
import { accountSafeInteger } from "../customer-account/customer-account.service.js";

const customerSelect = {
  id: true,
  companyId: true,
  address: true,
  city: true,
  commercialName: true,
  email: true,
  contactName: true,
  phone: true,
  documentNumber: true,
  documentType: true,
  fiscalAddress: true,
  legalName: true,
  locality: true,
  personType: true,
  postalCode: true,
  priceList: true,
  province: true,
  status: true,
  vatCondition: true,
} as const;

const vatConditionValues = {
  "Consumidor final": "FINAL_CONSUMER",
  Exento: "EXEMPT",
  Monotributista: "MONOTRIBUTISTA",
  "Responsable inscripto": "REGISTERED_TAXPAYER",
} as const;

@Injectable()
export class CustomersService {
  constructor(private readonly database: DatabaseService) {}

  async list(session: SessionContext, query: CustomerQuery): Promise<Page<CustomerListItemDto>> {
    const term = normalizeSearch(query.search ?? "");
    const escapedTerm = term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const digits = term.replaceAll(/\D/g, "");
    const hasDigitSeparators = /\d/.test(term) && /[\s.-]/.test(term);
    const where: Prisma.CustomerWhereInput = {
      companyId: session.companyId,
      ...(query.status ? { status: query.status === "active" ? "ACTIVE" : "INACTIVE" } : {}),
      ...(query.vatCondition ? { vatCondition: vatConditionValues[query.vatCondition] } : {}),
      ...(term
        ? {
            OR: [
              { searchText: { contains: escapedTerm } },
              ...(hasDigitSeparators && digits ? [{ searchText: { contains: digits } }] : []),
            ],
          }
        : {}),
    };
    const { skip, take } = paginate(query.page, query.pageSize);
    const [rows, total] = await Promise.all([
      this.database.customer.findMany({
        where,
        orderBy: [{ nameNormalized: "asc" }, { id: "asc" }],
        skip,
        take,
        select: customerSelect,
      }),
      this.database.customer.count({ where }),
    ]);
    const balances = await this.balancesFor(
      session.companyId,
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) => ({
        ...mapCustomerToDto(row),
        balanceCents: balances.get(row.id) ?? 0,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async get(session: SessionContext, id: string): Promise<CustomerDto> {
    const row = await this.database.customer.findUnique({
      where: { id_companyId: { id, companyId: session.companyId } },
    });
    if (!row) throw this.notFound();
    return mapCustomerToDto(row);
  }

  async create(session: SessionContext, input: CustomerInput): Promise<CustomerDto> {
    const data = mapCustomerCreateInputToPersistence(input);
    try {
      const row = await this.database.customer.create({
        data: {
          ...data,
          companyId: session.companyId,
        },
      });
      return mapCustomerToDto(row);
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) throw this.documentConflict();
      throw error;
    }
  }

  async update(session: SessionContext, id: string, input: CustomerInput): Promise<CustomerDto> {
    const data = mapCustomerInputToPersistence(input);
    try {
      const duplicate = await this.database.customer.findFirst({
        where: {
          companyId: session.companyId,
          documentType: data.documentType,
          documentNumber: data.documentNumber,
          NOT: { id },
        },
        select: { id: true },
      });
      if (duplicate) throw this.documentConflict();
      const result = await this.database.customer.updateMany({
        where: { id, companyId: session.companyId },
        data,
      });
      if (result.count === 0) throw this.notFound();
      return await this.get(session, id);
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) throw this.documentConflict();
      throw error;
    }
  }

  async deactivate(session: SessionContext, id: string): Promise<CustomerDto> {
    const result = await this.database.customer.updateMany({
      where: { id, companyId: session.companyId },
      data: { status: "INACTIVE" },
    });
    if (result.count === 0) throw this.notFound();
    return this.get(session, id);
  }

  async setStatus(
    session: SessionContext,
    id: string,
    status: "active" | "inactive",
  ): Promise<CustomerDto> {
    const result = await this.database.customer.updateMany({
      where: { id, companyId: session.companyId },
      data: { status: status === "active" ? "ACTIVE" : "INACTIVE" },
    });
    if (result.count === 0) throw this.notFound();
    return this.get(session, id);
  }

  // Misma fórmula que CustomerAccountService.getSummary (comprobantes no anulados - cobros), una consulta por página.
  private async balancesFor(companyId: string, ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.database.$queryRaw<{ id: string; balance: bigint }[]>(Prisma.sql`
      SELECT c.id,
        (COALESCE((SELECT SUM(d.total_cents::bigint) FROM documents d
          WHERE d.company_id = ${companyId} AND d.customer_id = c.id AND d.status <> 'CANCELLED'), 0)
        - COALESCE((SELECT SUM(m.amount::bigint) FROM cash_movements m
          WHERE m.company_id = ${companyId} AND m.customer_id = c.id), 0))::bigint AS balance
      FROM customers c
      WHERE c.company_id = ${companyId} AND c.id IN (${Prisma.join(ids)})
    `);
    return new Map(rows.map((row) => [row.id, accountSafeInteger(row.balance)]));
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
  }

  private documentConflict(): ApiException {
    return new ApiException("conflict", messageKey("customer.document.conflict"), 409, {
      documentNumber: ["customer.document.conflict"],
    });
  }

  private notFound(): ApiException {
    return new ApiException("not_found", messageKey("customer.notFound"), 404);
  }
}
