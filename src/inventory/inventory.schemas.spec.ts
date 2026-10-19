import { describe, expect, it } from "vitest";
import { inventoryMovementQuerySchema } from "./inventory.schemas.js";

describe("inventoryMovementQuerySchema", () => {
  it("rejects nonexistent and malformed dates", () => {
    expect(inventoryMovementQuerySchema.safeParse({ from: "2026-02-31" }).success).toBe(false);
    expect(inventoryMovementQuerySchema.safeParse({ to: "10-09-2026" }).success).toBe(false);
  });

  it("places inverted range errors on both date fields", () => {
    const result = inventoryMovementQuerySchema.safeParse({ from: "2026-10-10", to: "2026-10-09" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toEqual([["from"], ["to"]]);
    }
  });

  it("accepts equal dates and either date independently", () => {
    for (const query of [
      { from: "2026-10-09", to: "2026-10-09" },
      { from: "2026-10-09" },
      { to: "2026-10-09" },
    ])
      expect(inventoryMovementQuerySchema.safeParse(query).success).toBe(true);
  });

  it("validates product ids and rejects unknown parameters", () => {
    expect(inventoryMovementQuerySchema.safeParse({ productId: "" }).success).toBe(false);
    expect(inventoryMovementQuerySchema.safeParse({ productId: "x".repeat(101) }).success).toBe(
      false,
    );
    expect(inventoryMovementQuerySchema.safeParse({ sort: "id" }).success).toBe(false);
  });

  it("accepts type=Reversion", () => {
    expect(inventoryMovementQuerySchema.safeParse({ type: "Reversion" }).success).toBe(true);
  });
});
