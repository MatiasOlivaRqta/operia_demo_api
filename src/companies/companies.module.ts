import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { CompaniesController } from "./companies.controller.js";

@Module({ imports: [AuthModule], controllers: [CompaniesController] })
export class CompaniesModule {}
