import { describe, expect, it } from "vitest";
import { allocate } from "./cash.allocation.js";

describe("allocate", () => {
  const docs = [
    { documentId: "old", pending: 100 },
    { documentId: "new", pending: 200 },
  ];

  it.each([
    [100, 100, 0],
    [60, 60, 0],
    [150, 100, 50],
  ])("allocates target payment %i", (amount, applied, credit) => {
    expect(allocate(amount, docs, "old")).toEqual({
      applications: [{ documentId: "old", amount: applied }],
      creditGenerated: credit,
    });
  });

  it("targets only the specified document", () => {
    expect(allocate(250, docs, "new")).toEqual({
      applications: [{ documentId: "new", amount: 200 }],
      creditGenerated: 50,
    });
  });

  it("uses the received order, including the caller's date and id tie-break", () => {
    expect(allocate(150, docs)).toEqual({
      applications: [
        { documentId: "old", amount: 100 },
        { documentId: "new", amount: 50 },
      ],
      creditGenerated: 0,
    });
    expect(allocate(150, [...docs].reverse())).toEqual({
      applications: [{ documentId: "new", amount: 150 }],
      creditGenerated: 0,
    });
  });

  it("generates credit with no debt or a settled target", () => {
    expect(allocate(100, [])).toEqual({ applications: [], creditGenerated: 100 });
    expect(allocate(100, [{ documentId: "paid", pending: 0 }], "paid")).toEqual({
      applications: [],
      creditGenerated: 100,
    });
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid amount %s",
    (amount) => {
      expect(() => allocate(amount, docs)).toThrow(RangeError);
    },
  );

  it("rejects invalid pending amounts, duplicates and absent targets", () => {
    for (const pending of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => allocate(100, [{ documentId: "bad", pending }])).toThrow(RangeError);
    }
    expect(() => allocate(100, [docs[0], docs[0]])).toThrow(RangeError);
    expect(() => allocate(100, docs, "missing")).toThrow(RangeError);
  });

  it("conserves every cent and never exceeds a document's debt", () => {
    for (const amount of [1, 99, 100, 101, 300, 301, Number.MAX_SAFE_INTEGER]) {
      for (const target of [undefined, "old", "new"]) {
        const result = allocate(amount, docs, target);
        expect(
          result.applications.reduce((sum, entry) => sum + entry.amount, result.creditGenerated),
        ).toBe(amount);
        for (const application of result.applications) {
          expect(application.amount).toBeGreaterThan(0);
          expect(application.amount).toBeLessThanOrEqual(
            docs.find((doc) => doc.documentId === application.documentId)!.pending,
          );
        }
      }
    }
  });
});
