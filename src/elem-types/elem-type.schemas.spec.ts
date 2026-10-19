import { describe, expect, it } from "vitest";
import { normalizeDescription } from "./elem-types.service.js";
import { subTypeQuerySchema, subTypeSchema } from "./elem-type.schemas.js";

describe("sub type schemas", () => {
  it("trims the description and bounds it to 1-100 characters", () => {
    expect(subTypeSchema.parse({ description: " Pinturas " })).toEqual({ description: "Pinturas" });
    for (const description of ["", "   ", "a".repeat(101)])
      expect(subTypeSchema.safeParse({ description }).success).toBe(false);
    expect(subTypeSchema.safeParse({ description: "a".repeat(100) }).success).toBe(true);
  });

  it("rejects unknown body fields", () => {
    expect(subTypeSchema.safeParse({ description: "x", elemTypeId: "PROD_CAT" }).success).toBe(
      false,
    );
  });

  it("defaults pagination and rejects invalid sizes", () => {
    expect(subTypeQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    for (const value of [{ pageSize: "101" }, { page: "0" }, { other: "1" }])
      expect(subTypeQuerySchema.safeParse(value).success).toBe(false);
  });
});

describe("normalizeDescription", () => {
  it("unifies case, accents and extra spaces", () => {
    const variants = ["Ferretería", "ferreteria", " FERRETERÍA ", "ferretería"];
    expect(new Set(variants.map(normalizeDescription))).toEqual(new Set(["ferreteria"]));
    expect(normalizeDescription("Año   Nuevo")).toBe("ano nuevo");
  });
});
