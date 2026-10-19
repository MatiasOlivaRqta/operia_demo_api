import { Test as NestTest } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { ApiExceptionFilter } from "../src/common/api-exception.filter.js";
import { DocsController, DOCS_ENABLED } from "../src/docs/docs.controller.js";

describe("API docs access (e2e)", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each([
    { enabled: true, status: 200 },
    { enabled: false, status: 404 },
  ])("returns $status for docs routes when enabled=$enabled", async ({ enabled, status }) => {
    const moduleRef = await NestTest.createTestingModule({
      controllers: [DocsController],
      providers: [{ provide: DOCS_ENABLED, useValue: enabled }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    const docs = await request(app.getHttpServer()).get("/docs").expect(status);
    const docsJson = await request(app.getHttpServer()).get("/docs-json").expect(status);
    if (enabled) {
      expect(docs.text).toContain("Operia API");
      expect(docsJson.body).toHaveProperty("openapi", "3.0.3");
    } else {
      expect(docs.body).toMatchObject({ error: { code: "not_found" } });
      expect(docsJson.body).toMatchObject({ error: { code: "not_found" } });
    }
  });
});
