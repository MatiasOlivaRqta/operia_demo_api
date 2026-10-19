import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "./app.module.js";
import { DatabaseService } from "./database/database.service.js";

describe("AppModule", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("wires authentication, companies, health and persistence providers", async () => {
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({
        $connect: vi.fn(),
        $disconnect: vi.fn(),
        checkConnection: vi.fn(),
      } as unknown as DatabaseService)
      .compile();
    app = moduleRef.createNestApplication();

    await expect(app.init()).resolves.toBe(app);
  });
});
