import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { env } from "../src/config/env.js";
import { buildProductIndexFields, normalizeSearch } from "../src/common/search.js";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });

type SeedMovement = [
  id: string,
  type: "INGRESO" | "SALIDA" | "AJUSTE",
  quantity: number,
  reference: string,
  note: string,
  date: string,
];
const sourceProducts: Array<{
  id: string;
  companyId: string;
  sku: string;
  barcode: string;
  name: string;
  category: string;
  unit: string;
  costCents: number;
  priceCents: number;
  minimumStock: number;
  status: "ACTIVE";
  movements: SeedMovement[];
}> = [
  {
    id: "taladro-percutor-13mm",
    companyId: "operia-central",
    sku: "HER-TAL-013",
    barcode: "7791234567890",
    name: "Taladro percutor 13 mm",
    category: "Herramientas",
    unit: "Unidad",
    costCents: 1860000,
    priceCents: 3290000,
    minimumStock: 8,
    status: "ACTIVE" as const,
    movements: [
      ["stock-1", "INGRESO" as const, 24, "Ingreso I-0008", "Compra inicial", "2026-08-01"],
      ["stock-2", "SALIDA" as const, -12, "Salida S-0142", "Factura A-0001-00002440", "2026-08-20"],
      ["stock-3", "AJUSTE" as const, -2, "Ajuste A-0007", "Conteo físico", "2026-08-25"],
    ],
  },
  {
    id: "tornillo-tirafondo-6x60",
    companyId: "operia-central",
    sku: "FER-TIR-660",
    barcode: "7791234567906",
    name: "Tornillo tirafondo 6 x 60",
    category: "Ferreteria",
    unit: "Unidad",
    costCents: 75000,
    priceCents: 135000,
    minimumStock: 150,
    status: "ACTIVE" as const,
    movements: [
      ["stock-4", "INGRESO" as const, 600, "Ingreso I-0009", "Compra inicial", "2026-08-03"],
      [
        "stock-5",
        "SALIDA" as const,
        -478,
        "Salida S-0151",
        "Factura B-0001-00001836",
        "2026-08-24",
      ],
    ],
  },
  {
    id: "cable-taller-3x15",
    companyId: "operia-hogar",
    sku: "ELE-CAB-315",
    barcode: "7791234567913",
    name: "Cable taller 3 x 1,5 mm",
    category: "Electricidad",
    unit: "Metro",
    costCents: 420000,
    priceCents: 720000,
    minimumStock: 40,
    status: "ACTIVE" as const,
    movements: [
      ["stock-6", "INGRESO" as const, 250, "Ingreso I-0010", "Compra inicial", "2026-08-04"],
      [
        "stock-7",
        "SALIDA" as const,
        -214,
        "Salida S-0131",
        "Factura A-0001-00002412",
        "2026-08-18",
      ],
    ],
  },
  {
    id: "guante-nitrilo-pro",
    companyId: "operia-hogar",
    sku: "SEG-GUA-NIT",
    barcode: "7791234567920",
    name: "Guante de nitrilo Pro",
    category: "Seguridad",
    unit: "Par",
    costCents: 980000,
    priceCents: 1680000,
    minimumStock: 24,
    status: "ACTIVE" as const,
    movements: [
      ["stock-8", "INGRESO" as const, 80, "Ingreso I-0011", "Compra inicial", "2026-08-02"],
      ["stock-9", "SALIDA" as const, -56, "Salida S-0148", "Factura A-0001-00002457", "2026-08-21"],
    ],
  },
];

const documents = [
  {
    id: "pv-0001-00002457",
    companyId: "operia-central",
    customerId: "distribuidora-norte",
    customerName: "Distribuidora Norte",
    internalNumber: "0001-00002457",
    pointOfSale: "0001",
    status: "COMPLETED" as const,
    totalCents: 21204040,
    idempotencyKey: "seed-pv-0001-00002457",
    requestFingerprint: "seed:pv-0001-00002457",
    searchText: "0001-00002457 distribuidora norte",
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    items: [
      {
        productId: "taladro-percutor-13mm",
        productName: "Taladro percutor 13 mm",
        sku: "HER-TAL-013",
        quantity: 2,
        unitPriceCents: 3290000,
        discountRate: 0,
        taxRate: 21,
      },
      {
        productId: "cable-taller-3x15",
        productName: "Cable taller 3 x 1,5 mm",
        sku: "ELE-CAB-315",
        quantity: 16,
        unitPriceCents: 720000,
        discountRate: 5,
        taxRate: 21,
      },
    ],
  },
  {
    id: "pv-0001-00002440",
    companyId: "operia-hogar",
    customerId: "punto-hogar",
    customerName: "Punto Hogar",
    internalNumber: "0001-00002440",
    pointOfSale: "0001",
    status: "CANCELLED" as const,
    cancellationReason: "ANU-0001-00000018",
    cancelledAt: new Date("2026-08-18T00:00:00.000Z"),
    totalCents: 47770800,
    idempotencyKey: "seed-pv-0001-00002440",
    requestFingerprint: "seed:pv-0001-00002440",
    searchText: "0001-00002440 punto hogar",
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
    items: [
      {
        productId: "taladro-percutor-13mm",
        productName: "Taladro percutor 13 mm",
        sku: "HER-TAL-013",
        quantity: 12,
        unitPriceCents: 3290000,
        discountRate: 0,
        taxRate: 21,
      },
    ],
  },
];

async function main(): Promise<void> {
  // PROD_CAT lo crea la migración; acá sólo las categorías de ejemplo por empresa.
  const categoryId = (product: { companyId: string; category: string }) =>
    `cat-${product.companyId}-${normalizeSearch(product.category)}`;
  await prisma.elemSubType.createMany({
    data: sourceProducts.map((product) => ({
      id: categoryId(product),
      companyId: product.companyId,
      elemTypeId: "PROD_CAT",
      description: product.category,
      descriptionNormalized: normalizeSearch(product.category),
    })),
    skipDuplicates: true,
  });
  const products = sourceProducts.map(({ movements, category, ...product }) => ({
    ...product,
    categoryId: categoryId({ companyId: product.companyId, category }),
    stockOnHand: movements.reduce((total, movement) => total + Number(movement[2]), 0),
    ...buildProductIndexFields({ ...product, category }),
  }));
  await prisma.product.createMany({ data: products, skipDuplicates: true });

  const movements = sourceProducts.flatMap((product) =>
    product.movements.map(([id, type, quantity, reference, note, date]) => ({
      id,
      companyId: product.companyId,
      productId: product.id,
      type,
      quantity,
      reference,
      note,
      createdAt: new Date(`${date}T00:00:00.000Z`),
    })),
  );
  await prisma.stockMovement.createMany({ data: movements, skipDuplicates: true });

  for (const document of documents) {
    const { items, ...row } = document;
    await prisma.document.createMany({ data: [row], skipDuplicates: true });
    await prisma.documentItem.createMany({
      data: items.map((item, position) => ({
        ...item,
        id: `${document.id}-item-${position + 1}`,
        companyId: document.companyId,
        documentId: document.id,
        position,
      })),
      skipDuplicates: true,
    });
  }

  for (const companyId of new Set(documents.map(({ companyId }) => companyId))) {
    const lastNumber = Math.max(
      ...documents
        .filter((document) => document.companyId === companyId)
        .map(({ internalNumber }) => Number(internalNumber.split("-").at(-1))),
    );
    await prisma.documentCounter.upsert({
      where: { companyId },
      create: { companyId, lastNumber },
      update: {},
    });
  }
}

main().finally(() => prisma.$disconnect());
