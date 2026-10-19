import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { env } from "../src/config/env.js";
import { buildProductIndexFields } from "../src/common/search.js";

const args = process.argv.slice(2);
const valueAfter = (flag: string, fallback: string): string => {
  const equalForm = args.find((arg) => arg.startsWith(`${flag}=`));
  if (equalForm) return equalForm.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? "") : fallback;
};
const count = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 10_000);
const companyId = valueAfter("--company", "operia-central");
const movementsPerProduct = Number(valueAfter("--movements-per-product", "3"));
if (
  !Number.isSafeInteger(count) ||
  count < 0 ||
  !Number.isSafeInteger(movementsPerProduct) ||
  movementsPerProduct < 0 ||
  !companyId
) {
  throw new Error("Argumentos inválidos para db:seed:load");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
try {
  const categoryId = `cat-${companyId}-carga`;
  await prisma.elemSubType.createMany({
    data: [
      {
        id: categoryId,
        companyId,
        elemTypeId: "PROD_CAT",
        description: "Carga",
        descriptionNormalized: "carga",
      },
    ],
    skipDuplicates: true,
  });
  for (let start = 0; start < count; start += 1000) {
    const size = Math.min(1000, count - start);
    const rows = Array.from({ length: size }, (_, offset) => {
      const n = start + offset + 1;
      const id = `load-${companyId}-${String(n).padStart(8, "0")}`;
      const name = `Producto de carga ${String(n).padStart(8, "0")}`;
      const sku = `LOAD-${n}`;
      const quantities = Array.from({ length: movementsPerProduct }, (_, i) => (i + 1) * 10);
      return {
        id,
        companyId,
        sku,
        barcode: "",
        name,
        categoryId,
        unit: "Unidad",
        costCents: 100,
        priceCents: 200,
        minimumStock: 5,
        stockOnHand: quantities.reduce((sum, quantity) => sum + quantity, 0),
        status: "ACTIVE" as const,
        ...buildProductIndexFields({ name, sku, barcode: "", category: "Carga" }),
      };
    });
    await prisma.product.createMany({ data: rows, skipDuplicates: true });
    const movements = rows.flatMap((product) =>
      Array.from({ length: movementsPerProduct }, (_, index) => ({
        id: `${product.id}-stock-${index + 1}`,
        companyId,
        productId: product.id,
        type: "INGRESO" as const,
        quantity: (index + 1) * 10,
        reference: "Carga sintética",
        note: "Carga sintética",
      })),
    );
    for (let movementStart = 0; movementStart < movements.length; movementStart += 1000) {
      await prisma.stockMovement.createMany({
        data: movements.slice(movementStart, movementStart + 1000),
        skipDuplicates: true,
      });
    }
  }
} finally {
  await prisma.$disconnect();
}
