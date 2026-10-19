import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { SessionCleanupService } from "./session-cleanup.service.js";

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionCleanupService],
  exports: [AuthService],
})
export class AuthModule {}
