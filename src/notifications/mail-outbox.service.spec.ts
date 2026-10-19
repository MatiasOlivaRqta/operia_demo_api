import { describe, expect, it } from "vitest";
import { mailBackoffMs, mailErrorClass } from "./mail-outbox.service.js";

describe("mail retry helpers", () => {
  it("uses increasing delays and caps further retries at six hours", () => {
    expect([1, 2, 3, 4, 5, 6, 100].map(mailBackoffMs)).toEqual([
      60000, 300000, 1800000, 7200000, 21600000, 21600000, 21600000,
    ]);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid attempt %s", (attempt) => {
    expect(() => mailBackoffMs(attempt)).toThrow(RangeError);
  });
  it("persists only the class, ignoring message, name and stack", () => {
    const error = new TypeError("SMTP auth secret for private@example.com");
    error.name = "private@example.com";
    expect(mailErrorClass(error)).toBe("TypeError");
    expect(mailErrorClass({ name: "secret", message: "private@example.com" })).toBe("UnknownError");
  });
  it("truncates class names and rejects names with addresses", () => {
    const LongError = class extends Error {};
    Object.defineProperty(LongError, "name", { value: "E".repeat(200) });
    expect(mailErrorClass(new LongError())).toBe("E".repeat(100));
    Object.defineProperty(LongError, "name", { value: "private@example.com" });
    expect(mailErrorClass(new LongError())).toBe("UnknownError");
  });
});
