import "dotenv/config";
import "./setup-env.js";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CashTestHarness, cashHttp, type CashFixture } from "./cash-operations.helpers.js";

type CollectionItem = {
  kind: "PAYMENT" | "CREDIT_APPLIED";
  occurredAt: string;
  amountCents: number;
  paymentMethod: string | null;
  receiptNumber: string | null;
  cashMovementId: string | null;
};
type DocumentCollections = {
  items: CollectionItem[];
  totalCents: number;
  paidCents: number;
  pendingCents: number;
};
type CollectionApplications = {
  cashMovementId: string;
  receiptNumber: string | null;
  paymentMethod: string;
  totalCents: number;
  documents: Array<{
    documentId: string;
    documentNumber: string;
    amountCents: number;
    status: string;
  }>;
  creditGeneratedCents: number;
};
type CashReceipt = { movementId: string; receiptNumber: string };

describe("Document collection relations (e2e)", () => {
  const h = new CashTestHarness();
  let fixture: CashFixture;
  let customerId: string;
  let sessionId: string;
  const extraUserIds: string[] = [];
  const extraRoleIds: string[] = [];

  beforeAll(async () => h.init());
  beforeEach(async () => {
    h.resetRateLimits();
    fixture = await h.fixture();
    customerId = await h.customer(fixture);
    sessionId = await h.session(fixture);
  });
  afterEach(async () => {
    await h.database.session.deleteMany({ where: { userId: { in: extraUserIds } } });
    await h.database.membership.deleteMany({ where: { userId: { in: extraUserIds } } });
    await h.database.user.deleteMany({ where: { id: { in: extraUserIds } } });
    await h.database.role.deleteMany({ where: { id: { in: extraRoleIds } } });
    extraUserIds.length = 0;
    extraRoleIds.length = 0;
    await h.clean();
  });
  afterAll(async () => h.app?.close());

  function collect(
    amountCents: number,
    options: { documentId?: string; paymentMethod?: "CASH" | "TRANSFER" | "CARD" } = {},
  ) {
    return cashHttp(h.app, "post", `/cash/sessions/${sessionId}/collections`)
      .set("Cookie", fixture.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({
        customerId,
        amountCents,
        paymentMethod: options.paymentMethod ?? "CASH",
        ...options,
      });
  }

  function applyCredit(documentId: string, amountCents: number) {
    return cashHttp(h.app, "post", `/customers/${customerId}/account/applications`)
      .set("Cookie", fixture.cookie)
      .send({ documentId, amountCents });
  }

  function documentCollections(documentId: string, cookie = fixture.cookie) {
    return cashHttp(h.app, "get", `/documents/${documentId}/collections`).set("Cookie", cookie);
  }

  function collectionApplications(ownerId: string, movementId: string, cookie = fixture.cookie) {
    return cashHttp(h.app, "get", `/customers/${ownerId}/account/collections/${movementId}`).set(
      "Cookie",
      cookie,
    );
  }

  async function limitedUser(permissions: string[]): Promise<string> {
    const role = await h.database.role.create({
      data: { companyId: fixture.companyId, name: `E2E ${randomUUID()}`, permissions },
      select: { id: true },
    });
    extraRoleIds.push(role.id);
    const password = "document-collections-e2e-password";
    const user = await h.database.user.create({
      data: {
        email: `${randomUUID()}@e2e.operia.invalid`,
        name: "Collections E2E",
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        memberships: { create: { companyId: fixture.companyId, roleId: role.id } },
      },
      select: { id: true, email: true },
    });
    extraUserIds.push(user.id);
    const login = await cashHttp(h.app, "post", "/auth/login")
      .send({ email: user.email, password })
      .expect(200);
    const header = login.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0] : header;
    if (typeof cookie !== "string") throw new Error("El login no creó la cookie de sesión.");
    return cookie.split(";")[0]!;
  }

  it("lists cash and credit applications chronologically with matching paid and pending totals", async () => {
    await collect(30_000).expect(201); // Generates credit before the document exists.
    const documentId = await h.document(fixture, customerId, 184_200);
    const cash = (await collect(100_000, { documentId, paymentMethod: "CASH" }).expect(201))
      .body as CashReceipt;
    const transfer = (await collect(34_200, { documentId, paymentMethod: "TRANSFER" }).expect(201))
      .body as CashReceipt;
    await applyCredit(documentId, 30_000).expect(201);

    await h.database.cashMovement.update({
      where: { id_companyId: { id: cash.movementId, companyId: fixture.companyId } },
      data: { createdAt: new Date("2026-10-10T12:00:00.000Z") },
    });
    await h.database.cashMovement.update({
      where: { id_companyId: { id: transfer.movementId, companyId: fixture.companyId } },
      data: { createdAt: new Date("2026-10-11T12:00:00.000Z") },
    });
    // El endpoint ordena por la fecha de la imputación: se alinea con la del cobro, como en un alta real.
    await h.database.accountEntry.updateMany({
      where: { companyId: fixture.companyId, cashMovementId: cash.movementId, documentId },
      data: { createdAt: new Date("2026-10-10T12:00:00.000Z") },
    });
    await h.database.accountEntry.updateMany({
      where: { companyId: fixture.companyId, cashMovementId: transfer.movementId, documentId },
      data: { createdAt: new Date("2026-10-11T12:00:00.000Z") },
    });
    await h.database.accountEntry.updateMany({
      where: { companyId: fixture.companyId, documentId, type: "CREDIT_APPLIED" },
      data: { createdAt: new Date("2026-10-12T12:00:00.000Z") },
    });

    const response = await documentCollections(documentId).expect(200);
    const body = response.body as DocumentCollections;
    expect(body).toMatchObject({ totalCents: 184_200, paidCents: 164_200, pendingCents: 20_000 });
    expect(body.items).toEqual([
      {
        kind: "PAYMENT",
        occurredAt: "2026-10-10T09:00:00.000-03:00",
        amountCents: 100_000,
        paymentMethod: "CASH",
        receiptNumber: cash.receiptNumber,
        cashMovementId: cash.movementId,
      },
      {
        kind: "PAYMENT",
        occurredAt: "2026-10-11T09:00:00.000-03:00",
        amountCents: 34_200,
        paymentMethod: "TRANSFER",
        receiptNumber: transfer.receiptNumber,
        cashMovementId: transfer.movementId,
      },
      {
        kind: "CREDIT_APPLIED",
        occurredAt: "2026-10-12T09:00:00.000-03:00",
        amountCents: 30_000,
        paymentMethod: null,
        receiptNumber: null,
        cashMovementId: null,
      },
    ]);
    expect(body.items.reduce((sum, item) => sum + item.amountCents, 0)).toBe(body.paidCents);
  });

  it("shows an automatic collection across three documents from the collection and each document", async () => {
    const documentIds = await Promise.all([
      h.document(fixture, customerId, 100_000, { createdAt: new Date("2026-10-01T12:00:00Z") }),
      h.document(fixture, customerId, 100_000, { createdAt: new Date("2026-10-02T12:00:00Z") }),
      h.document(fixture, customerId, 100_000, { createdAt: new Date("2026-10-03T12:00:00Z") }),
    ]);
    const receipt = (await collect(250_000).expect(201)).body as CashReceipt;
    const applications = await collectionApplications(customerId, receipt.movementId).expect(200);
    const body = applications.body as CollectionApplications;
    expect(body.documents).toEqual([
      {
        documentId: documentIds[0],
        documentNumber: expect.any(String),
        amountCents: 100_000,
        status: "COMPLETED",
      },
      {
        documentId: documentIds[1],
        documentNumber: expect.any(String),
        amountCents: 100_000,
        status: "COMPLETED",
      },
      {
        documentId: documentIds[2],
        documentNumber: expect.any(String),
        amountCents: 50_000,
        status: "PARTIAL",
      },
    ]);
    expect(body).toMatchObject({
      cashMovementId: receipt.movementId,
      receiptNumber: receipt.receiptNumber,
      paymentMethod: "CASH",
      totalCents: 250_000,
      creditGeneratedCents: 0,
    });

    for (const [index, amountCents] of [100_000, 100_000, 50_000].entries()) {
      const document = await documentCollections(documentIds[index]!).expect(200);
      expect(document.body).toMatchObject({ paidCents: amountCents });
      expect((document.body as DocumentCollections).items).toEqual([
        expect.objectContaining({
          kind: "PAYMENT",
          amountCents,
          paymentMethod: "CASH",
          receiptNumber: receipt.receiptNumber,
          cashMovementId: receipt.movementId,
        }),
      ]);
    }
  });

  it("reports surplus credit and an on-account collection without documents", async () => {
    const documentId = await h.document(fixture, customerId, 184_200);
    const surplus = (await collect(200_000, { documentId }).expect(201)).body as CashReceipt;
    const surplusDetail = await collectionApplications(customerId, surplus.movementId).expect(200);
    expect(surplusDetail.body).toMatchObject({
      totalCents: 200_000,
      documents: [expect.objectContaining({ documentId, amountCents: 184_200 })],
      creditGeneratedCents: 15_800,
    });

    const anotherCustomerId = await h.customer(fixture);
    const onAccountResult = await cashHttp(h.app, "post", `/cash/sessions/${sessionId}/collections`)
      .set("Cookie", fixture.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ customerId: anotherCustomerId, amountCents: 50_000, paymentMethod: "TRANSFER" })
      .expect(201);
    const onAccount = onAccountResult.body as CashReceipt;
    await expect(
      collectionApplications(anotherCustomerId, onAccount.movementId),
    ).resolves.toMatchObject({
      status: 200,
      body: expect.objectContaining({ documents: [], creditGeneratedCents: 50_000 }),
    });
  });

  it("returns the correct empty details for pending and cancelled documents", async () => {
    const pending = await h.document(fixture, customerId, 1_000);
    const cancelled = await h.document(fixture, customerId, 2_000);
    await cashHttp(h.app, "post", `/documents/${cancelled}/cancellation`)
      .set("Cookie", fixture.cookie)
      .send({ reason: "Prueba de cancelación" })
      .expect(201);

    expect((await documentCollections(pending).expect(200)).body).toMatchObject({
      items: [],
      totalCents: 1_000,
      paidCents: 0,
      pendingCents: 1_000,
    });
    expect((await documentCollections(cancelled).expect(200)).body).toMatchObject({
      items: [],
      totalCents: 2_000,
      paidCents: 0,
      pendingCents: 0,
    });
  });

  it("hides foreign company documents and collections with 404", async () => {
    const foreign = await h.fixture();
    const foreignCustomerId = await h.customer(foreign);
    const foreignDocumentId = await h.document(foreign, foreignCustomerId, 1_000);
    const foreignSessionId = await h.session(foreign);
    const foreignCollection = await h.movement(foreign, foreignSessionId, foreignCustomerId, 1_000);

    await documentCollections(foreignDocumentId).expect(404);
    await collectionApplications(customerId, foreignCollection).expect(404);
  });

  it("enforces read permissions on both routes while accepting either document permission", async () => {
    const documentId = await h.document(fixture, customerId, 1_000);
    const movementId = await h.movement(fixture, sessionId, customerId, 1_000);
    const noReadCookie = await limitedUser([]);
    const documentsOnlyCookie = await limitedUser(["documents.read"]);
    const accountOnlyCookie = await limitedUser(["account.read"]);

    await documentCollections(documentId, noReadCookie).expect(403);
    await collectionApplications(customerId, movementId, noReadCookie).expect(403);
    await collectionApplications(customerId, movementId, documentsOnlyCookie).expect(403);
    await documentCollections(documentId, documentsOnlyCookie).expect(200);
    await documentCollections(documentId, accountOnlyCookie).expect(200);
  });

  it("returns 404 when a collection belongs to another customer of the same company", async () => {
    const otherCustomerId = await h.customer(fixture);
    const otherMovementId = await h.movement(fixture, sessionId, otherCustomerId, 1_000);
    await collectionApplications(customerId, otherMovementId).expect(404);
  });
});
