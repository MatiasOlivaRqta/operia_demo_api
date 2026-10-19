import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service.js";
import { UsersService } from "./users.service.js";

describe("UsersService", () => {
  const tx = {
    $queryRaw: vi.fn(),
    role: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn() },
    membership: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
  };
  const database = {
    role: { findFirst: vi.fn() },
    membership: { findMany: vi.fn() },
    $transaction: vi.fn((work: (transaction: typeof tx) => unknown) => work(tx)),
  } as unknown as DatabaseService;
  const service = new UsersService(database);
  const session = { companyId: "company-1", userId: "admin-1" } as never;
  beforeEach(() => {
    vi.resetAllMocks();
    tx.role.findFirst.mockResolvedValue({ id: "role-1", name: "Editor" });
    (database.role.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "role-1" });
  });

  it("lista solo campos públicos con rol y orden estable por nombre/correo", async () => {
    const rows = [
      {
        user: { id: "u1", email: "u@example.test", name: "User" },
        role: { id: "r1", name: "Editor" },
      },
    ];
    (database.membership.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    await expect(service.list(session)).resolves.toEqual([
      { ...rows[0]!.user, role: rows[0]!.role },
    ]);
    expect(database.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ user: { name: "asc" } }, { user: { email: "asc" } }] }),
    );
  });

  it("rechaza rol de otra empresa", async () => {
    (database.role.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(
      service.create(session, {
        email: "user@example.test",
        name: "User",
        password: "long-password-123",
        roleId: "role-foreign",
      }),
    ).rejects.toMatchObject({ code: "validation", fieldErrors: { roleId: expect.any(Array) } });
  });

  it("agrega un usuario existente sin modificar nombre ni passwordHash", async () => {
    tx.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "existing@example.test",
      name: "Nombre existente",
    });
    tx.membership.findUnique.mockResolvedValue(null);
    await expect(
      service.create(session, {
        email: "existing@example.test",
        name: "Nombre nuevo",
        password: "long-password-123",
        roleId: "role-1",
      }),
    ).resolves.toMatchObject({ name: "Nombre existente" });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.membership.create).toHaveBeenCalled();
  });

  it("rechaza correo que ya es miembro", async () => {
    tx.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "existing@example.test",
      name: "Existing",
    });
    tx.membership.findUnique.mockResolvedValue({ userId: "u1" });
    await expect(
      service.create(session, {
        email: "existing@example.test",
        name: "New",
        password: "long-password-123",
        roleId: "role-1",
      }),
    ).rejects.toMatchObject({ code: "conflict", fieldErrors: { email: expect.any(Array) } });
  });

  it("protege último ADMIN, permite cambio propio solo con otro ADMIN y bloquea auto-baja", async () => {
    tx.membership.findUnique.mockResolvedValue({ userId: "admin-1", role: { name: "ADMIN" } });
    tx.membership.count.mockResolvedValueOnce(0);
    await expect(service.update(session, "admin-1", { roleId: "role-1" })).rejects.toMatchObject({
      code: "business_rule",
    });
    tx.membership.count.mockResolvedValueOnce(1);
    tx.user.findUnique.mockResolvedValue({ id: "admin-1", email: "a@b.test", name: "Admin" });
    await expect(service.update(session, "admin-1", { roleId: "role-1" })).resolves.toMatchObject({
      role: { name: "Editor" },
    });
    await expect(service.remove(session, "admin-1")).rejects.toMatchObject({
      code: "business_rule",
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it("no permite dejar la empresa sin ADMIN al dar de baja al último", async () => {
    tx.membership.findUnique.mockResolvedValue({ userId: "u2", role: { name: "ADMIN" } });
    tx.membership.count.mockResolvedValue(0);
    await expect(service.remove(session, "u2")).rejects.toMatchObject({ code: "business_rule" });
    expect(tx.membership.delete).not.toHaveBeenCalled();
  });

  it("devuelve not_found para membresía de otra empresa y permite baja de otro miembro", async () => {
    tx.membership.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.update(session, "foreign-user", { roleId: "role-1" }),
    ).rejects.toMatchObject({ code: "not_found" });
    tx.membership.findUnique.mockResolvedValueOnce({ userId: "u2", role: { name: "Editor" } });
    await expect(service.remove(session, "u2")).resolves.toBeUndefined();
    expect(tx.membership.delete).toHaveBeenCalledWith({
      where: { userId_companyId: { userId: "u2", companyId: "company-1" } },
    });
  });
});
