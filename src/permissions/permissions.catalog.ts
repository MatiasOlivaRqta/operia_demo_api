export const PERMISSION_CATALOG = {
  customers: ["customers.read", "customers.write"],
  products: ["products.read", "products.write"],
  inventory: ["inventory.read", "inventory.write", "inventory.cancel"],
  documents: ["documents.read", "documents.write", "documents.cancel"],
  cash: ["cash.read", "cash.write"],
  account: ["account.read", "account.write"],
  dashboard: ["dashboard.read"],
  users: ["users.manage"],
} as const;

export type Permission = (typeof PERMISSION_CATALOG)[keyof typeof PERMISSION_CATALOG][number];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSION_CATALOG).flatMap(
  (permissions) => [...permissions],
);

const permissionSet: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return permissionSet.has(value);
}
