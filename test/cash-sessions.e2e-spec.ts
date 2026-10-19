import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CashTestHarness, cashHttp, type CashFixture } from "./cash-operations.helpers.js";
import type { CashSessionDto } from "../src/cash/cash-sessions.mapper.js";

describe("Cash sessions (e2e)", () => {
  const h = new CashTestHarness();
  let own: CashFixture;
  let foreign: CashFixture;
  beforeAll(async () => h.init());
  beforeEach(async () => {
    h.resetRateLimits();
    own = await h.fixture();
    foreign = await h.fixture();
  });
  afterEach(async () => h.clean());
  afterAll(async () => h.app?.close());

  function open(body: object = { openingBalanceCents: 100000 }) {
    return cashHttp(h.app, "post", "/cash/sessions").set("Cookie", own.cookie).send(body);
  }
  function close(id: string, body: object, cookie = own.cookie) {
    return cashHttp(h.app, "post", `/cash/sessions/${id}/close`).set("Cookie", cookie).send(body);
  }
  function row(id: string) {
    return h.database.cashSession.findUniqueOrThrow({
      where: { id_companyId: { id, companyId: own.companyId } },
    });
  }
  function notices(id: string) {
    return h.database.mailOutbox.findMany({
      where: { companyId: own.companyId, notificationKey: `cash-close:${id}` },
    });
  }

  it("opens, returns current without tenant internals, closes and opens again", async () => {
    expect(
      (await cashHttp(h.app, "get", "/cash/sessions/current").set("Cookie", own.cookie).expect(200))
        .body,
    ).toBeNull();
    const opened = (await open().expect(201)).body as CashSessionDto;
    expect(opened).toMatchObject({
      status: "OPEN",
      openedBy: { name: own.name },
      openingBalanceCents: 100000,
    });
    expect(opened.openedAt).toMatch(/-03:00$/);
    expect(await row(opened.id)).toMatchObject({ openedByUserId: own.userId, status: "OPEN" });
    const current = await cashHttp(h.app, "get", "/cash/sessions/current")
      .set("Cookie", own.cookie)
      .expect(200);
    expect(current.body).toEqual(opened);
    expect(current.body).not.toHaveProperty("companyId");
    await close(opened.id, { declaredBalanceCents: 100000 }).expect(200);
    expect(
      (await cashHttp(h.app, "get", "/cash/sessions/current").set("Cookie", own.cookie).expect(200))
        .body,
    ).toBeNull();
    const next = (await open().expect(201)).body as CashSessionDto;
    expect(next.id).not.toBe(opened.id);
    expect(
      await h.database.cashSession.count({ where: { companyId: own.companyId, status: "OPEN" } }),
    ).toBe(1);
  });

  it.each([
    { openingBalanceCents: -1 },
    { openingBalanceCents: 2147483648 },
    { openingBalanceCents: 0, companyId: "foreign" },
  ])("rejects invalid opening %j without creating a drawer", async (body) => {
    expect((await open(body).expect(400)).body).toMatchObject({ error: { code: "validation" } });
    expect(await h.database.cashSession.count({ where: { companyId: own.companyId } })).toBe(0);
  });

  it("rejects the removed operatorName field", async () => {
    expect(
      (await open({ openingBalanceCents: 0, operatorName: "Ana" }).expect(400)).body,
    ).toMatchObject({ error: { code: "validation" } });
    expect(await h.database.cashSession.count({ where: { companyId: own.companyId } })).toBe(0);
  });

  it("rejects a second opening without changing the existing session", async () => {
    const opened = (await open().expect(201)).body as CashSessionDto;
    const before = await row(opened.id);
    expect((await open({ openingBalanceCents: 1 }).expect(409)).body).toMatchObject({
      error: { code: "conflict" },
    });
    expect(await row(opened.id)).toEqual(before);
    expect(await h.database.cashSession.count({ where: { companyId: own.companyId } })).toBe(1);
  });

  it("allows only one simultaneous opening", async () => {
    const results = await Promise.all([open(), open()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await h.database.cashSession.count({ where: { companyId: own.companyId, status: "OPEN" } }),
    ).toBe(1);
    expect(await h.database.cashSession.count({ where: { companyId: own.companyId } })).toBe(1);
  });

  it("closes without observation when cash matches and enqueues no notice", async () => {
    const id = await h.session(own, 100000);
    const customer = await h.customer(own);
    await h.movement(own, id, customer, 184200);
    const result = await close(id, { declaredBalanceCents: 284200 }).expect(200);
    expect(result.body).toMatchObject({
      status: "CLOSED",
      theoreticalBalanceCents: 284200,
      declaredBalanceCents: 284200,
      differenceCents: 0,
    });
    expect(result.body).not.toHaveProperty("observation");
    expect(await row(id)).toMatchObject({
      status: "CLOSED",
      theoreticalBalance: 284200n,
      difference: 0n,
      observation: null,
    });
    expect(await notices(id)).toEqual([]);
  });

  it("counts only cash, excluding transfer and card", async () => {
    const id = await h.session(own, 100000);
    const customer = await h.customer(own);
    await h.movement(own, id, customer, 50000);
    await h.movement(own, id, customer, 400000, "TRANSFER");
    await h.movement(own, id, customer, 500000, "CARD");
    expect((await close(id, { declaredBalanceCents: 150000 }).expect(200)).body).toMatchObject({
      theoreticalBalanceCents: 150000,
      differenceCents: 0,
    });
    expect(await notices(id)).toEqual([]);
  });

  it("persists a negative difference, closing member and one pending notification", async () => {
    const id = await h.session(own, 100000);
    const customer = await h.customer(own);
    await h.movement(own, id, customer, 184200);
    const closer = await h.fixture(own.companyId, "Beatriz E2E");
    const response = await close(
      id,
      { declaredBalanceCents: 284000, observation: "Faltó vuelto" },
      closer.cookie,
    ).expect(200);
    expect(response.body).toMatchObject({
      status: "CLOSED",
      theoreticalBalanceCents: 284200,
      differenceCents: -200,
      observation: "Faltó vuelto",
      openedBy: { name: own.name },
      closedBy: { name: closer.name },
      closedAt: expect.stringMatching(/-03:00$/),
    });
    const closedSession = response.body as Extract<CashSessionDto, { status: "CLOSED" }>;
    expect(closedSession.openedBy.name).not.toBe(closedSession.closedBy.name);
    expect(await row(id)).toMatchObject({
      openedByUserId: own.userId,
      closedByUserId: closer.userId,
      declaredBalance: 284000n,
      theoreticalBalance: 284200n,
      difference: -200n,
      observation: "Faltó vuelto",
    });
    const queued = await notices(id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      notificationKey: `cash-close:${id}`,
      status: "PENDING",
      attempts: 0,
      payload: {
        differenceCents: -200,
        theoreticalCents: 284200,
        declaredCents: 284000,
        closedBy: { name: closer.name },
      },
    });
    expect(queued[0]?.recipients.length).toBeGreaterThan(0);
  });

  it.each([
    { declaredBalanceCents: 284000 },
    { declaredBalanceCents: 284000, observation: "   " },
    { declaredBalanceCents: 285000 },
  ])("rejects a difference without meaningful observation: %j", async (body) => {
    const id = await h.session(own, 100000);
    await h.movement(own, id, await h.customer(own), 184200);
    const before = await row(id);
    expect((await close(id, body).expect(422)).body).toMatchObject({
      error: {
        code: "business_rule",
        fieldErrors: { observation: expect.arrayContaining([expect.any(String)]) },
      },
    });
    expect(await row(id)).toEqual(before);
    expect(await notices(id)).toEqual([]);
  });

  it("rejects repeated close without altering any persisted closing value", async () => {
    const id = await h.session(own, 100000);
    await close(id, { declaredBalanceCents: 99000, observation: "Primero" }).expect(200);
    const before = await row(id);
    await close(id, { declaredBalanceCents: 50000, observation: "Segundo" }).expect(409);
    expect(await row(id)).toEqual(before);
    expect(await notices(id)).toHaveLength(1);
  });

  it("serializes simultaneous closes and enqueues exactly one notice", async () => {
    const id = await h.session(own, 100000);
    const results = await Promise.all([
      close(id, { declaredBalanceCents: 99000, observation: "Cierre A" }),
      close(id, { declaredBalanceCents: 98000, observation: "Cierre B" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!.body as Extract<
      CashSessionDto,
      { status: "CLOSED" }
    >;
    expect(await row(id)).toMatchObject({
      status: "CLOSED",
      declaredBalance: BigInt(winner.declaredBalanceCents),
      difference: BigInt(winner.differenceCents),
      observation: winner.observation,
    });
    expect(await notices(id)).toHaveLength(1);
  });

  it("hides foreign sessions, validates UUID and requires cookies on all cash routes", async () => {
    const id = await h.session(foreign);
    const before = await h.database.cashSession.findUniqueOrThrow({
      where: { id_companyId: { id, companyId: foreign.companyId } },
    });
    expect((await close(id, { declaredBalanceCents: 0 }).expect(404)).body).toMatchObject({
      error: { code: "not_found" },
    });
    expect(
      await h.database.cashSession.findUniqueOrThrow({
        where: { id_companyId: { id, companyId: foreign.companyId } },
      }),
    ).toEqual(before);
    await close("not-a-uuid", { declaredBalanceCents: 0 }).expect(400);
    await cashHttp(h.app, "post", "/cash/sessions").send({ openingBalanceCents: 0 }).expect(401);
    await cashHttp(h.app, "post", `/cash/sessions/${id}/close`)
      .send({ declaredBalanceCents: 0 })
      .expect(401);
    await cashHttp(h.app, "post", `/cash/sessions/${id}/collections`)
      .set("Idempotency-Key", "no-cookie-key")
      .send({ customerId: "customer", amountCents: 1, paymentMethod: "CASH" })
      .expect(401);
    for (const path of [
      "/cash/sessions/current",
      "/cash/sessions/current/totals",
      "/cash/movements",
    ])
      await cashHttp(h.app, "get", path).expect(401);
  });
});

describe("Cash close without configured recipients (e2e)", () => {
  const h = new CashTestHarness();
  beforeAll(async () => h.init([]));
  afterEach(async () => h.clean());
  afterAll(async () => h.app?.close());
  it("closes a difference normally without creating outbox mail", async () => {
    h.resetRateLimits();
    const fixture = await h.fixture();
    const id = await h.session(fixture, 100000);
    const response = await cashHttp(h.app, "post", `/cash/sessions/${id}/close`)
      .set("Cookie", fixture.cookie)
      .send({ declaredBalanceCents: 99000, observation: "Faltante" })
      .expect(200);
    expect(response.body).toMatchObject({ status: "CLOSED", differenceCents: -1000 });
    expect(await h.database.mailOutbox.count({ where: { companyId: fixture.companyId } })).toBe(0);
  });
});
