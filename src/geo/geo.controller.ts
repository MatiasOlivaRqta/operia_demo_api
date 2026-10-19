import { Controller, Get, Param } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { GeoService } from "./geo.service.js";

@Controller("geo")
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Get("provinces")
  provinces() {
    return this.geo.provinces();
  }

  @Get("provinces/:provinceId/localities")
  localities(
    @Param(new ZodValidationPipe(z.object({ provinceId: z.string().regex(/^\d{2}$/) }).strict()))
    params: {
      provinceId: string;
    },
  ) {
    return this.geo.localities(params.provinceId);
  }
}
