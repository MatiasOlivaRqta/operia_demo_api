import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { DATABASE_CONNECTION, type DatabaseConnection } from "../database/database-connection.js";

export type HealthResponse = { status: "ok" };

@Injectable()
export class HealthService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async check(): Promise<HealthResponse> {
    try {
      await this.database.checkConnection();
      return { status: "ok" };
    } catch {
      throw new ServiceUnavailableException({ status: "error" });
    }
  }
}
