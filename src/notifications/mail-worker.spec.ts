import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../config/env.js";
import { MailOutboxService } from "./mail-outbox.service.js";
import { MailWorker } from "./mail-worker.js";
import type { DatabaseService } from "../database/database.service.js";

describe("MailWorker lifecycle", () => {
  const originalPoll = env.MAIL_POLL_SECONDS;
  afterEach(() => {
    env.MAIL_POLL_SECONDS = originalPoll;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  function workerFixture() {
    // No I/O: every processing call is intercepted at the outbox boundary.
    const outbox = new MailOutboxService({} as DatabaseService);
    const take = vi.spyOn(outbox, "takeDueBatch").mockResolvedValue([]);
    const worker = new MailWorker(outbox, { send: vi.fn().mockResolvedValue(undefined) });
    return { worker, take };
  }
  it("does not schedule a timer when polling is zero, but supports manual processing", async () => {
    vi.useFakeTimers();
    env.MAIL_POLL_SECONDS = 0;
    const { worker, take } = workerFixture();
    worker.onModuleInit();
    expect(vi.getTimerCount()).toBe(0);
    await worker.processDue();
    expect(take).toHaveBeenCalledOnce();
    await worker.onModuleDestroy();
  });
  it("polls and clears the timer on destruction", async () => {
    vi.useFakeTimers();
    env.MAIL_POLL_SECONDS = 2;
    const { worker, take } = workerFixture();
    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(take).toHaveBeenCalledOnce();
    await worker.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(take).toHaveBeenCalledOnce();
  });
  it("shares in-flight processing and waits for it during shutdown", async () => {
    const { worker, take } = workerFixture();
    let finish: (() => void) | undefined;
    take.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([]);
        }),
    );
    const first = worker.processDue();
    const second = worker.processDue();
    expect(first).toBe(second);
    expect(take).toHaveBeenCalledOnce();
    let stopped = false;
    const shutdown = worker.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish!();
    await Promise.all([first, shutdown]);
    expect(stopped).toBe(true);
  });
});
