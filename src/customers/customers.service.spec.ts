import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service.js";
import { customerQuerySchema } from "./customer.schemas.js";
import { CustomersService } from "./customers.service.js";

describe("CustomersService.list", () => {
  const findMany = vi.fn();
  const count = vi.fn();
  const database = {
    customer: { findMany, count },
  } as unknown as DatabaseService;
  const service = new CustomersService(database);
  const session = {
    userId: "user-1",
    companyId: "company-1",
    sessionId: "session-1",
    permissions: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);
  });

  it("paginates with stable normalized ordering and counts using the same where", async () => {
    const query = customerQuerySchema.parse({ page: "3", pageSize: "50" });
    const result = await service.list(session, query);
    const findArgs = findMany.mock.calls[0]?.[0];

    expect(result).toEqual({ items: [], page: 3, pageSize: 50, total: 0 });
    expect(findArgs).toMatchObject({
      where: { companyId: "company-1" },
      orderBy: [{ nameNormalized: "asc" }, { id: "asc" }],
      skip: 100,
      take: 50,
      select: { id: true, companyId: true, commercialName: true },
    });
    expect(findArgs).not.toHaveProperty("select.searchText");
    expect(findArgs).not.toHaveProperty("select.nameNormalized");
    expect(count).toHaveBeenCalledWith({ where: findArgs?.where });
  });

  it("combines company, status, VAT condition, and normalized search", async () => {
    const query = customerQuerySchema.parse({
      search: "Compañía",
      status: "inactive",
      vatCondition: "Exento",
    });
    await service.list(session, query);

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({
      companyId: "company-1",
      status: "INACTIVE",
      vatCondition: "EXEMPT",
      OR: [{ searchText: { contains: "compania" } }],
    });
  });

  it("escapes SQL LIKE wildcard characters before passing them to Prisma", async () => {
    const query = customerQuerySchema.parse({ search: "a%_\\" });
    await service.list(session, query);

    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      OR: [{ searchText: { contains: "a\\%\\_\\\\" } }],
    });
  });

  it("adds a digits only search branch for a document typed with separators", async () => {
    const query = customerQuerySchema.parse({ search: "20-12345" });
    await service.list(session, query);

    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      OR: [{ searchText: { contains: "20-12345" } }, { searchText: { contains: "2012345" } }],
    });
  });
});
