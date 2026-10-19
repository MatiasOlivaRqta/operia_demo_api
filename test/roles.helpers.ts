import type { DatabaseService } from "../src/database/database.service.js";

export async function adminRoleId(database: DatabaseService, companyId: string): Promise<string> {
  const role = await database.role.upsert({
    where: { companyId_name: { companyId, name: "ADMIN" } },
    create: { companyId, name: "ADMIN", isSystem: true, permissions: [] },
    update: {},
    select: { id: true },
  });
  return role.id;
}

export async function customRoleId(
  database: DatabaseService,
  companyId: string,
  name: string,
  permissions: string[],
): Promise<string> {
  const role = await database.role.create({
    data: { companyId, name, permissions, isSystem: false },
    select: { id: true },
  });
  return role.id;
}
