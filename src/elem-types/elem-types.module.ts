import { Module } from "@nestjs/common";
import { ElemTypesController } from "./elem-types.controller.js";
import { ElemTypesService } from "./elem-types.service.js";

@Module({ controllers: [ElemTypesController], providers: [ElemTypesService] })
export class ElemTypesModule {}
