import { describe, expect, it } from "vitest";
import { paginate, paginationSchema } from "./pagination.js";

describe("pagination", () => {
  it("coerces query parameters and applies defaults", () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(paginationSchema.parse({ page: "3", pageSize: "10" })).toEqual({
      page: 3,
      pageSize: 10,
    });
  });

  it("rejects values outside the page bounds", () => {
    expect(paginationSchema.safeParse({ page: "0" }).success).toBe(false);
    expect(paginationSchema.safeParse({ pageSize: "101" }).success).toBe(false);
  });

  it("calculates offset pagination", () => {
    expect(paginate(3, 10)).toEqual({ skip: 20, take: 10 });
  });
});
