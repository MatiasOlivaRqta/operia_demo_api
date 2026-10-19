import { describe, expect, it } from "vitest";
import { assertTestDatabaseUrl } from "./test-database.guard.js";

describe("assertTestDatabaseUrl", () => {
  it("accepts the exact operia_test database name", () => {
    expect(() =>
      assertTestDatabaseUrl("postgresql://user:pass@localhost:5432/operia_test"),
    ).not.toThrow();
  });

  it.each([
    "postgresql://user:pass@localhost:5432/operia",
    "postgresql://user:pass@localhost:5432/another_database",
    "postgresql://user:pass@localhost:5432/operia_test_backup",
  ])("rejects non-test database URL %s", (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrow(
      /solo pueden ejecutarse contra la base operia_test/,
    );
  });
});
