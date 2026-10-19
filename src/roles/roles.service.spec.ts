import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service.js";
import { RolesService } from "./roles.service.js";

describe("RolesService", () => {
  const findMany = vi.fn();
  const findFirst = vi.fn();
  const create = vi.fn();
  const updateMany = vi.fn();
  const deleteMany = vi.fn();
  const count = vi.fn();
  const database = {
    role: { findMany, findFirst, create, updateMany, deleteMany },
    membership: { count },
  } as unknown as DatabaseService;
  const service = new RolesService(database);
  const session = { companyId: "company-1" } as never;
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("expone el catálogo agrupado por módulo y lista con _count", async () => {
    findMany.mockResolvedValue([
      { id: "r1", name: "ADMIN", isSystem: true, permissions: [], _count: { memberships: 2 } },
    ]);
    expect(service.permissions()[0]).toMatchObject({
      module: "customers",
      permissions: ["customers.read", "customers.write"],
    });
    expect(await service.list(session)).toMatchObject([
      { permissions: expect.arrayContaining(["users.manage"]), userCount: 2 },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: { _count: { select: { memberships: true } } } }),
    );
  });

  it("rechaza nombre repetido antes de crear y mapea carrera P2002", async () => {
    findFirst.mockResolvedValueOnce({ id: "existing" });
    await expect(
      service.create(session, { name: "Operaciones", permissions: [] }),
    ).rejects.toMatchObject({ code: "validation", fieldErrors: { name: expect.any(Array) } });
    findFirst.mockResolvedValueOnce(null);
    create.mockRejectedValueOnce({ code: "P2002" });
    await expect(
      service.create(session, { name: "Operaciones", permissions: [] }),
    ).rejects.toMatchObject({ code: "validation", fieldErrors: { name: expect.any(Array) } });
  });

  it("rechaza roles de sistema inmutables", async () => {
    findFirst.mockResolvedValue({ id: "r1", isSystem: true });
    await expect(service.update(session, "r1", { name: "Otro" })).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
    await expect(service.remove(session, "r1")).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("impide borrar un rol asignado y traduce el FK RESTRICT", async () => {
    findFirst.mockResolvedValue({ id: "r1", isSystem: false });
    count.mockResolvedValueOnce(1);
    await expect(service.remove(session, "r1")).rejects.toMatchObject({ code: "conflict" });
    count.mockResolvedValueOnce(0);
    deleteMany.mockRejectedValueOnce({ code: "P2003" });
    await expect(service.remove(session, "r1")).rejects.toMatchObject({ code: "conflict" });
  });
});
