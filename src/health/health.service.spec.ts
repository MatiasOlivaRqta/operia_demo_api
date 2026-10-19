import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "../database/database-connection.js";
import { HealthService } from "./health.service.js";

describe("HealthService", () => {
  it("reports healthy only after the database query succeeds", async () => {
    const database: DatabaseConnection = { checkConnection: vi.fn() };
    const service = new HealthService(database);

    await expect(service.check()).resolves.toEqual({ status: "ok" });
    expect(database.checkConnection).toHaveBeenCalledOnce();
  });

  it("returns 503 without exposing database errors", async () => {
    const database = {
      checkConnection: vi.fn().mockRejectedValue(new Error("sensitive connection detail")),
    };
    const service = new HealthService(database);

    await expect(service.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.check()).rejects.toMatchObject({
      status: 503,
      response: { status: "error" },
    });
  });
});
