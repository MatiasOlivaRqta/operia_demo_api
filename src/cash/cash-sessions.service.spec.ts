import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "../generated/prisma/client.js";
import { DatabaseService } from "../database/database.service.js";
import { ApiException } from "../common/errors.js";
import { MailOutboxService } from "../notifications/mail-outbox.service.js";
import { calculateCashClose } from "./cash.close.js";
import {
  CashSessionsService,
  shouldEnqueueCashClose,
  validateCashClose,
} from "./cash-sessions.service.js";
import type { CashSessionRow } from "./cash-sessions.mapper.js";

const session = {
  companyId: "company",
  userId: "closing-user",
  sessionId: "auth-session",
  permissions: [],
};
const open: CashSessionRow = {
  id: "cash",
  status: "OPEN",
  openedAt: new Date("2026-10-09T13:00:00Z"),
  openedBy: { name: "Ana", email: "ana@tests.invalid" },
  openingBalance: 100000,
  closedAt: null,
  declaredBalance: null,
  theoreticalBalance: null,
  difference: null,
  observation: null,
  closedBy: null,
};
function fixture(recipients: readonly string[] = ["cash@tests.invalid"]) {
  const query = vi.fn().mockResolvedValue([{ id: open.id }]);
  const read = vi.fn().mockResolvedValue(open);
  const aggregate = vi.fn().mockResolvedValue({ _sum: { amount: 184200 } });
  const update = vi.fn().mockResolvedValue({
    ...open,
    status: "CLOSED",
    closedAt: new Date("2026-10-09T21:00:00Z"),
    declaredBalance: 284000n,
    theoreticalBalance: 284200n,
    difference: -200n,
    observation: "Faltó vuelto",
    closedBy: { name: "Beatriz" },
  } satisfies CashSessionRow);
  const tx = {
    $queryRaw: query,
    cashSession: { findUniqueOrThrow: read, update },
    cashMovement: { aggregate },
    company: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: "Empresa" }) },
    user: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ name: "Beatriz", email: "beatriz@tests.invalid" }),
    },
  };
  const database = {
    $transaction: vi.fn(async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      work(tx as unknown as Prisma.TransactionClient),
    ),
  };
  const mail = { enqueueCashCloseDifference: vi.fn().mockResolvedValue(undefined) };
  return {
    tx,
    query,
    read,
    aggregate,
    update,
    mail,
    service: new CashSessionsService(
      database as unknown as DatabaseService,
      mail as unknown as MailOutboxService,
      recipients,
    ),
  };
}

describe("cash session closing rules", () => {
  it.each([-200, 800])("requires a nonblank observation for difference %i", (difference) => {
    const close = calculateCashClose({
      openingBalance: 100000,
      cashCollected: 184200,
      declared: 284200 + difference,
    });
    for (const observation of [undefined, "", "   "]) {
      try {
        validateCashClose(close, observation);
        throw new Error("Expected rejection");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ApiException);
        if (error instanceof ApiException) {
          expect(error.getStatus()).toBe(422);
          expect(error.fieldErrors).toHaveProperty("observation");
        }
      }
    }
    expect(() => validateCashClose(close, " Faltó vuelto ")).not.toThrow();
  });
  it("does not require an observation or enqueue with zero difference", () => {
    const close = calculateCashClose({ openingBalance: 0, cashCollected: 0, declared: 0 });
    expect(() => validateCashClose(close)).not.toThrow();
    expect(shouldEnqueueCashClose(close, ["cash@tests.invalid"])).toBe(false);
  });
  it.each([-200, 800])("enqueues difference %i only with configured recipients", (difference) => {
    const close = calculateCashClose({
      openingBalance: 1000,
      cashCollected: 0,
      declared: 1000 + difference,
    });
    expect(shouldEnqueueCashClose(close, [])).toBe(false);
    expect(shouldEnqueueCashClose(close, ["cash@tests.invalid"])).toBe(true);
  });
});

describe("CashSessionsService.close", () => {
  it("does not return a successful close if outbox insertion fails", async () => {
    const f = fixture();
    f.mail.enqueueCashCloseDifference.mockRejectedValue(new Error("Outbox write failed"));
    await expect(
      f.service.close(session, "cash", {
        declaredBalanceCents: 284000,
        observation: "Faltó vuelto",
      }),
    ).rejects.toThrow("Outbox write failed");
  });
  it("locks the owned session, sums only CASH and queues audited data in the same transaction", async () => {
    const f = fixture();
    const result = await f.service.close(session, "cash", {
      declaredBalanceCents: 284000,
      observation: " Faltó vuelto ",
    });
    const sql = f.query.mock.calls[0]![0] as Prisma.Sql;
    expect(sql.text).toContain("FOR UPDATE");
    expect(sql.values).toEqual(["cash", "company"]);
    expect(f.aggregate).toHaveBeenCalledWith({
      where: { companyId: "company", sessionId: "cash", paymentMethod: "CASH" },
      _sum: { amount: true },
    });
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          closedByUserId: "closing-user",
          declaredBalance: 284000n,
          theoreticalBalance: 284200n,
          difference: -200n,
          observation: "Faltó vuelto",
        }),
      }),
    );
    expect(f.mail.enqueueCashCloseDifference).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        companyId: "company",
        sessionId: "cash",
        data: expect.objectContaining({
          closedBy: { name: "Beatriz", email: "beatriz@tests.invalid" },
          differenceCents: -200,
          companyName: "Empresa",
          openedBy: { name: "Ana", email: "ana@tests.invalid" },
        }),
      }),
    );
    expect(result).toHaveProperty("closedBy", { name: "Beatriz" });
  });
  it("rejects missing observation without updating or queuing", async () => {
    const f = fixture();
    await expect(
      f.service.close(session, "cash", { declaredBalanceCents: 284000 }),
    ).rejects.toMatchObject({
      code: "business_rule",
      fieldErrors: { observation: expect.any(Array) },
    });
    expect(f.update).not.toHaveBeenCalled();
    expect(f.mail.enqueueCashCloseDifference).not.toHaveBeenCalled();
  });
  it("omits the notification without difference", async () => {
    const f = fixture();
    await f.service.close(session, "cash", { declaredBalanceCents: 284200 });
    expect(f.mail.enqueueCashCloseDifference).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ difference: 0n, observation: null }),
      }),
    );
  });
  it("closes with no recipients and logs a warning without personal data", async () => {
    const warning = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const f = fixture([]);
      await f.service.close(session, "cash", {
        declaredBalanceCents: 284000,
        observation: "Faltó vuelto",
      });
      expect(f.update).toHaveBeenCalled();
      expect(f.mail.enqueueCashCloseDifference).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        "Aviso de diferencia omitido: no hay destinatarios configurados.",
      );
    } finally {
      warning.mockRestore();
    }
  });
  it("rejects an absent or foreign session with the same 404", async () => {
    const f = fixture();
    f.query.mockResolvedValue([]);
    await expect(
      f.service.close(session, "cash", { declaredBalanceCents: 0 }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "No encontramos la caja de la empresa activa.",
    });
    expect(f.update).not.toHaveBeenCalled();
  });
  it("rejects a closed session before calculating or updating", async () => {
    const f = fixture();
    f.read.mockResolvedValue({ ...open, status: "CLOSED" });
    await expect(
      f.service.close(session, "cash", { declaredBalanceCents: 0 }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.aggregate).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });
  it("rejects unsafe totals before persisting the close", async () => {
    const f = fixture();
    f.aggregate.mockResolvedValue({ _sum: { amount: Number.MAX_SAFE_INTEGER + 1 } });
    await expect(f.service.close(session, "cash", { declaredBalanceCents: 0 })).rejects.toThrow(
      "No se pudieron calcular los importes de caja.",
    );
    expect(f.update).not.toHaveBeenCalled();
  });
});

describe("CashSessionsService.open", () => {
  it("creates the session for the authenticated user without a supplied operator", async () => {
    const create = vi.fn().mockResolvedValue(open);
    const service = new CashSessionsService(
      { cashSession: { create } } as unknown as DatabaseService,
      {} as MailOutboxService,
      [],
    );

    await expect(service.open(session, { openingBalanceCents: 100000 })).resolves.toMatchObject({
      status: "OPEN",
      openedBy: { name: "Ana" },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        companyId: "company",
        openedByUserId: "closing-user",
        openingBalance: 100000,
        status: "OPEN",
      },
      select: expect.any(Object),
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("data.operatorName");
  });
});
