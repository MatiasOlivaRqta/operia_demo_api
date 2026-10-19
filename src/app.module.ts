import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { PermissionsGuard } from "./permissions/permissions.guard.js";
import { CompaniesModule } from "./companies/companies.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { CustomersModule } from "./customers/customers.module.js";
import { DocsModule } from "./docs/docs.module.js";
import { ProductsModule } from "./products/products.module.js";
import { InventoryModule } from "./inventory/inventory.module.js";
import { DocumentsModule } from "./documents/documents.module.js";
import { CashModule } from "./cash/cash.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { TelegramModule } from "./telegram/telegram.module.js";
import { CustomerAccountModule } from "./customer-account/customer-account.module.js";
import { ElemTypesModule } from "./elem-types/elem-types.module.js";
import { GeoModule } from "./geo/geo.module.js";
import { DashboardModule } from "./dashboard/dashboard.module.js";
import { RolesModule } from "./roles/roles.module.js";
import { UsersModule } from "./users/users.module.js";
import { env } from "./config/env.js";
import {
  API_RATE_LIMIT_SERVICE,
  ApiRateLimitService,
  apiRateLimiter,
} from "./common/api-rate-limit.js";

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    AuthModule,
    CompaniesModule,
    CustomersModule,
    ProductsModule,
    InventoryModule,
    DocumentsModule,
    CashModule,
    NotificationsModule,
    TelegramModule,
    CustomerAccountModule,
    GeoModule,
    DashboardModule,
    RolesModule,
    UsersModule,
    ElemTypesModule,
    DocsModule,
  ],
  providers: [
    {
      provide: API_RATE_LIMIT_SERVICE,
      useFactory: () =>
        new ApiRateLimitService(apiRateLimiter, {
          apiPerMinute: env.RATE_LIMIT_API_PER_MINUTE,
          anonymousPerMinute: env.RATE_LIMIT_ANONYMOUS_PER_MINUTE,
        }),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    // AuthGuard debe cargar primero la sesión para que PermissionsGuard pueda evaluarla.
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
