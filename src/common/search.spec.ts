import { describe, expect, it } from "vitest";
import { buildProductIndexFields, normalizeSearch } from "./search.js";

describe("normalizeSearch", () => {
  it("removes diacritics, lowercases and trims", () => {
    expect(normalizeSearch("  HERRAMIENTÁS eléctricas  ")).toBe("herramientas electricas");
  });

  it("normalizes product fields using the shared criterion", () => {
    expect(
      buildProductIndexFields({
        name: "Taladro Pércutor",
        sku: "HER-TAL",
        barcode: "779",
        category: "Herramientas",
      }),
    ).toEqual({
      searchText: "taladro percutor her-tal 779 herramientas",
      nameNormalized: "taladro percutor",
    });
  });
});
