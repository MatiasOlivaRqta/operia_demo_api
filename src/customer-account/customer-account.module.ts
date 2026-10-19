import { Module } from "@nestjs/common";
import { CustomerAccountService } from "./customer-account.service.js";
import { CustomerAccountController } from "./customer-account.controller.js";

@Module({
  controllers: [CustomerAccountController],
  providers: [CustomerAccountService],
  exports: [CustomerAccountService],
})
export class CustomerAccountModule {}
