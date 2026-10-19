import { z } from "zod";

export const dashboardActivityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(20).default(10),
  })
  .strict();

const centsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const dashboardActivityBaseSchema = z
  .object({
    id: z.string(),
    occurredAt: z.string().datetime({ offset: true }),
    reference: z.string(),
    counterparty: z.string(),
    refId: z.string(),
  })
  .strict();

export const dashboardActivityItemSchema = z.discriminatedUnion("kind", [
  dashboardActivityBaseSchema
    .extend({
      kind: z.literal("document"),
      amountCents: centsSchema,
      status: z.enum(["PENDING", "PARTIAL", "COMPLETED", "CANCELLED"]),
    })
    .strict(),
  dashboardActivityBaseSchema
    .extend({
      kind: z.literal("collection"),
      amountCents: centsSchema,
      status: z.literal("COLLECTED"),
    })
    .strict(),
  dashboardActivityBaseSchema
    .extend({
      kind: z.literal("stock_movement"),
      quantity: z.number().int(),
      status: z.enum(["INGRESO", "SALIDA", "AJUSTE", "REVERSION"]),
    })
    .strict(),
]);

export const dashboardActivityResponseSchema = z
  .object({
    items: z.array(dashboardActivityItemSchema),
  })
  .strict();

export const dashboardSummarySchema = z
  .object({
    date: z.iso.date(),
    salesToday: z
      .object({
        totalCents: centsSchema,
        count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        previousDayTotalCents: centsSchema,
      })
      .strict(),
    collectionsToday: z
      .object({
        totalCents: centsSchema,
        count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    receivables: z
      .object({
        balanceCents: centsSchema,
        customersWithBalance: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    lowStockCount: z.number().int().nonnegative(),
  })
  .strict();

export type DashboardActivityQuery = z.infer<typeof dashboardActivityQuerySchema>;
export type DashboardActivityItem = z.infer<typeof dashboardActivityItemSchema>;
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
