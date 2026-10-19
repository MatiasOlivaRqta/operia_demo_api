import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CashTestHarness, cashHttp, type CashFixture } from "./cash-operations.helpers.js";

type ApiErrorResponse = { error: { code: string; message: string } };

describe("API error localization (e2e)", () => {
  const h = new CashTestHarness();
  let fixture: CashFixture;

  beforeAll(async () => h.init());
  beforeEach(async () => {
    h.resetRateLimits();
    fixture = await h.fixture();
  });
  afterEach(async () => h.clean());
  afterAll(async () => h.app?.close());

  it("preserves status and code while translating not found, auth, cash rule and validation errors", async () => {
    const unknownPath = (language?: string) => {
      const request = cashHttp(h.app, "get", "/resource-that-does-not-exist");
      return language ? request.set("Accept-Language", language) : request;
    };
    await expectLocalized((language) => unknownPath(language));
    await expectLocalized((language) => {
      const request = cashHttp(h.app, "get", "/cash/sessions/current");
      return language ? request.set("Accept-Language", language) : request;
    });

    const sessionId = await h.session(fixture, 0);
    await expectLocalized((language) => {
      const request = cashHttp(h.app, "post", `/cash/sessions/${sessionId}/close`)
        .set("Cookie", fixture.cookie)
        .send({ declaredBalanceCents: 1 });
      return language ? request.set("Accept-Language", language) : request;
    });
    await expectLocalized((language) => {
      const request = cashHttp(h.app, "post", "/customers")
        .set("Cookie", fixture.cookie)
        .send({ documentNumber: "" });
      return language ? request.set("Accept-Language", language) : request;
    });
  });

  async function expectLocalized(
    createRequest: (language?: string) => PromiseLike<{ status: number; body: unknown }>,
  ): Promise<void> {
    const spanish = await createRequest().then((response) => response);
    const english = await createRequest("en").then((response) => response);
    expect(english.status).toBe(spanish.status);
    const spanishError = spanish.body as ApiErrorResponse;
    const englishError = english.body as ApiErrorResponse;
    expect(englishError.error.code).toBe(spanishError.error.code);
    expect(englishError.error.message).not.toBe(spanishError.error.message);
    expect(englishError.error.message).toMatch(/[A-Za-z]/);
  }
});
