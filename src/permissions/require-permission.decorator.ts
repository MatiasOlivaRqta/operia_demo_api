import { SetMetadata } from "@nestjs/common";
import type { Permission } from "./permissions.catalog.js";

export const REQUIRE_PERMISSION_KEY = "requirePermission";

export const RequirePermission = (
  ...permissions: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRE_PERMISSION_KEY, permissions);
