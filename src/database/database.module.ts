import { Global, Module } from "@nestjs/common";
import { DATABASE_CONNECTION } from "./database-connection.js";
import { DatabaseService } from "./database.service.js";

@Global()
@Module({
  providers: [DatabaseService, { provide: DATABASE_CONNECTION, useExisting: DatabaseService }],
  exports: [DATABASE_CONNECTION, DatabaseService],
})
export class DatabaseModule {}
