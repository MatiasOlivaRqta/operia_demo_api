import { ALL_PERMISSIONS, isPermission, type Permission } from "./permissions.catalog.js";

export function permissionsForRole(role: {
  name: string;
  isSystem: boolean;
  permissions: readonly string[];
}): Permission[] {
  if (role.isSystem && role.name === "ADMIN") return [...ALL_PERMISSIONS];

  const permissions = new Set<Permission>();
  for (const permission of role.permissions) {
    if (isPermission(permission)) permissions.add(permission);
  }
  return [...permissions];
}
