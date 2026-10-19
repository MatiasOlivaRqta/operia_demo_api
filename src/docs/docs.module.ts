import { Module } from "@nestjs/common";
import { env } from "../config/env.js";
import { DocsController } from "./docs.controller.js";
import { DOCS_ENABLED } from "./docs.controller.js";

@Module({
  controllers: [DocsController],
  providers: [{ provide: DOCS_ENABLED, useValue: env.DOCS_ENABLED }],
})
export class DocsModule {}
