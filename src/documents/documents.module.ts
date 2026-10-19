import { Module } from "@nestjs/common";
import { DocumentsController } from "./documents.controller.js";
import { DocumentsService } from "./documents.service.js";
import { CustomerAccountModule } from "../customer-account/customer-account.module.js";

@Module({
  imports: [CustomerAccountModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
