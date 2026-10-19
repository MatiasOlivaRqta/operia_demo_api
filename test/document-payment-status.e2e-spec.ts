import "dotenv/config";
import "./setup-env.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { settlementStatus } from "../src/cash/settlement-status.js";
import { CustomerAccountService } from "../src/customer-account/customer-account.service.js";
import { CashTestHarness, cashHttp, type CashFixture } from "./cash-operations.helpers.js";

type DocumentStatus = "PENDING" | "PARTIAL" | "COMPLETED" | "CANCELLED";
type DocumentRow = { id: string; status: DocumentStatus; totalCents: number };

describe("Document payment status (e2e)", () => {
  const h = new CashTestHarness();
  let fixture: CashFixture;
  let customerId: string;
  let sessionId: string;
  let account: CustomerAccountService;

  beforeAll(async () => {
    await h.init();
    account = h.app.get(CustomerAccountService);
  });
  beforeEach(async () => {
    h.resetRateLimits();
    fixture = await h.fixture();
    customerId = await h.customer(fixture);
    sessionId = await h.session(fixture);
  });
  afterEach(async () => h.clean());
  afterAll(async () => h.app?.close());

  function collect(amountCents: number, documentId?: string) {
    return cashHttp(h.app, "post", `/cash/sessions/${sessionId}/collections`)
      .set("Cookie", fixture.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({
        customerId,
        amountCents,
        paymentMethod: "CASH",
        ...(documentId ? { documentId } : {}),
      });
  }

  function apply(documentId: string, amountCents: number) {
    return cashHttp(h.app, "post", `/customers/${customerId}/account/applications`)
      .set("Cookie", fixture.cookie)
      .send({ documentId, amountCents });
  }

  function cancel(documentId: string) {
    return cashHttp(h.app, "post", `/documents/${documentId}/cancellation`)
      .set("Cookie", fixture.cookie)
      .send({ reason: "Prueba de estado de pago" });
  }

  async function row(id: string): Promise<DocumentRow> {
    const found = await h.database.document.findUniqueOrThrow({
      where: { id_companyId: { id, companyId: fixture.companyId } },
      select: { id: true, status: true, totalCents: true },
    });
    return found;
  }

  it("transitions an issued document from PENDING through PARTIAL to COMPLETED", async () => {
    const id = await h.document(fixture, customerId, 1000);
    expect((await row(id)).status).toBe("PENDING");
    await collect(400, id).expect(201);
    expect((await row(id)).status).toBe("PARTIAL");
    await collect(600, id).expect(201);
    expect((await row(id)).status).toBe("COMPLETED");
    expect(await account.getDocumentBalance(fixture.companyId, id)).toMatchObject({
      pendingCents: 0,
      paidCents: 1000,
    });
  });

  it("returns the remaining amount in document details for every payment status", async () => {
    const pending = await h.document(fixture, customerId, 1000);
    const partial = await h.document(fixture, customerId, 1000);
    const completed = await h.document(fixture, customerId, 1000);
    const cancelled = await h.document(fixture, customerId, 1000, { status: "CANCELLED" });
    await collect(375, partial).expect(201);
    await collect(1000, completed).expect(201);

    const readDetail = (id: string) =>
      cashHttp(h.app, "get", `/documents/${id}`).set("Cookie", fixture.cookie).expect(200);

    expect((await readDetail(pending)).body).toMatchObject({
      status: "PENDING",
      pendingCents: 1000,
    });
    expect((await readDetail(partial)).body).toMatchObject({
      status: "PARTIAL",
      pendingCents: 625,
    });
    expect((await readDetail(completed)).body).toMatchObject({
      status: "COMPLETED",
      pendingCents: 0,
    });
    expect((await readDetail(cancelled)).body).toMatchObject({
      status: "CANCELLED",
      pendingCents: 0,
    });
  });

  it("completes an overpaid document and keeps the excess as customer credit", async () => {
    const id = await h.document(fixture, customerId, 1000);
    const response = await collect(1250, id).expect(201);
    expect(response.body).toMatchObject({ creditGeneratedCents: 250, customerCreditCents: 250 });
    expect((await row(id)).status).toBe("COMPLETED");
    expect(await account.getTotals(fixture.companyId, customerId)).toEqual({
      debtCents: 0,
      creditCents: 250,
    });
  });

  it("allocates one account collection FIFO across a completed and partial document", async () => {
    const older = await h.document(fixture, customerId, 500, {
      createdAt: new Date("2026-10-01T12:00:00Z"),
    });
    const newer = await h.document(fixture, customerId, 700, {
      createdAt: new Date("2026-10-02T12:00:00Z"),
    });
    const response = await collect(800).expect(201);
    expect(response.body).toMatchObject({
      applications: [
        { documentId: older, amountCents: 500 },
        { documentId: newer, amountCents: 300 },
      ],
    });
    expect((await row(older)).status).toBe("COMPLETED");
    expect((await row(newer)).status).toBe("PARTIAL");
  });

  it("applies customer credit partially and then exactly to settle a document", async () => {
    // El saldo a favor se genera antes del comprobante: un cobro posterior lo imputaría por FIFO.
    await collect(2000).expect(201);
    const id = await h.document(fixture, customerId, 1000);
    await apply(id, 300).expect(201);
    expect((await row(id)).status).toBe("PARTIAL");
    await apply(id, 700).expect(201);
    expect((await row(id)).status).toBe("COMPLETED");
    expect(await account.getTotals(fixture.companyId, customerId)).toEqual({
      debtCents: 0,
      creditCents: 1000,
    });
  });

  it("cancels only PENDING documents and rejects cancellation of PARTIAL and COMPLETED", async () => {
    const pending = await h.document(fixture, customerId, 1000);
    const partial = await h.document(fixture, customerId, 1000);
    const completed = await h.document(fixture, customerId, 1000);
    await collect(1, partial).expect(201);
    await collect(1000, completed).expect(201);
    await cancel(pending).expect(201);
    expect((await row(pending)).status).toBe("CANCELLED");
    await cancel(partial).expect(409);
    await cancel(completed).expect(409);
    expect((await row(partial)).status).toBe("PARTIAL");
    expect((await row(completed)).status).toBe("COMPLETED");
  });

  it("rejects collection and credit application against a COMPLETED document with 422", async () => {
    const paid = await h.document(fixture, customerId, 1000);
    const creditSource = await h.document(fixture, customerId, 1000);
    await collect(1000, paid).expect(201);
    await collect(1200, creditSource).expect(201);
    await collect(1, paid).expect(422);
    await apply(paid, 1).expect(422);
  });

  it("includes PENDING, PARTIAL and COMPLETED in sales, debt, account summary and movements", async () => {
    const now = new Date();
    const pending = await h.document(fixture, customerId, 1000, { createdAt: now });
    const partial = await h.document(fixture, customerId, 2000, { createdAt: now });
    const completed = await h.document(fixture, customerId, 3000, { createdAt: now });
    await collect(500, partial).expect(201);
    await collect(3000, completed).expect(201);

    const dashboard = await cashHttp(h.app, "get", "/dashboard/summary")
      .set("Cookie", fixture.cookie)
      .expect(200);
    expect(dashboard.body).toMatchObject({
      salesToday: { totalCents: 6000, count: 3 },
      receivables: { balanceCents: 2500, customersWithBalance: 1 },
    });
    const summary = await cashHttp(h.app, "get", `/customers/${customerId}/account/summary`)
      .set("Cookie", fixture.cookie)
      .expect(200);
    expect(summary.body).toMatchObject({
      invoicedCents: 6000,
      collectedCents: 3500,
      netBalanceCents: 2500,
    });
    const movements = await cashHttp(h.app, "get", `/customers/${customerId}/account/movements`)
      .set("Cookie", fixture.cookie)
      .expect(200);
    expect((movements.body as { items: Array<{ id: string }> }).items.map(({ id }) => id)).toEqual(
      expect.arrayContaining([`doc:${pending}`, `doc:${partial}`, `doc:${completed}`]),
    );
    const customerPage = await cashHttp(h.app, "get", "/customers?pageSize=100")
      .set("Cookie", fixture.cookie)
      .expect(200);
    expect(
      (customerPage.body as { items: Array<{ id: string; balanceCents: number }> }).items.find(
        (item) => item.id === customerId,
      )?.balanceCents,
    ).toBe(2500);
  });

  it("keeps every non-cancelled document status equal to its account-entry settlement", async () => {
    const pending = await h.document(fixture, customerId, 1000);
    const partial = await h.document(fixture, customerId, 1000);
    const completed = await h.document(fixture, customerId, 1000);
    const cancelled = await h.document(fixture, customerId, 1000, { status: "CANCELLED" });
    await collect(250, partial).expect(201);
    await collect(1000, completed).expect(201);
    const documents = await h.database.document.findMany({
      where: { companyId: fixture.companyId },
      select: { id: true, status: true, totalCents: true },
    });
    expect(documents).toHaveLength(4);
    for (const document of documents) {
      const entries = await h.database.accountEntry.findMany({
        where: {
          companyId: fixture.companyId,
          documentId: document.id,
          type: { in: ["PAYMENT_APPLIED", "CREDIT_APPLIED"] },
        },
        select: { amount: true },
      });
      const paidCents = entries.reduce((sum, entry) => sum + entry.amount, 0);
      if (document.id === cancelled) {
        expect(document.status).toBe("CANCELLED");
      } else {
        expect(document.status).toBe(settlementStatus(document.totalCents, paidCents));
      }
    }
    expect([pending, partial, completed, cancelled]).toHaveLength(4);
  });

  it("reclassifies legacy statuses from imputations without changing customer debt", async () => {
    const noPayments = await h.document(fixture, customerId, 1000);
    const partiallyPaid = await h.document(fixture, customerId, 1000);
    const settled = await h.document(fixture, customerId, 1000);
    const cancelled = await h.document(fixture, customerId, 1000, { status: "CANCELLED" });
    await collect(400, partiallyPaid).expect(201);
    await collect(1000, settled).expect(201);

    const debtBefore = await account.getTotals(fixture.companyId, customerId);
    await h.database.document.updateMany({
      where: { companyId: fixture.companyId, status: { not: "CANCELLED" } },
      data: { status: "COMPLETED" },
    });
    expect(await row(noPayments)).toMatchObject({ status: "COMPLETED" });
    expect(await row(partiallyPaid)).toMatchObject({ status: "COMPLETED" });
    expect(await row(settled)).toMatchObject({ status: "COMPLETED" });
    expect(await row(cancelled)).toMatchObject({ status: "CANCELLED" });
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20261020000001_document_status_reclassify/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of migration
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean))
      await h.database.$executeRawUnsafe(statement);

    expect(await row(noPayments)).toMatchObject({ status: "PENDING" });
    expect(await row(partiallyPaid)).toMatchObject({ status: "PARTIAL" });
    expect(await row(settled)).toMatchObject({ status: "COMPLETED" });
    expect(await row(cancelled)).toMatchObject({ status: "CANCELLED" });
    expect(await account.getTotals(fixture.companyId, customerId)).toEqual(debtBefore);
    const defaultValue = await h.database.$queryRaw<Array<{ column_default: string | null }>>`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'documents' AND column_name = 'status'
    `;
    expect(defaultValue[0]?.column_default).toMatch(/PENDING/);
  });
});
