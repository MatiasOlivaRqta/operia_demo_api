import { Controller, Get, Inject } from "@nestjs/common";
import { type HealthResponse, HealthService } from "./health.service.js";
import { Public } from "../common/public.decorator.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  @Public()
  check(): Promise<HealthResponse> {
    return this.healthService.check();
  }
}
