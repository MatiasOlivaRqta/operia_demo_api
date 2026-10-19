import type { Prisma } from "../../src/generated/prisma/client.js";
import type { DatabaseService } from "../../src/database/database.service.js";
import { withCustomerIndexFields } from "./customers.js";

export async function createDashboardCustomer(
  database: Pick<DatabaseService, "customer">,
  companyId: string,
  index: number,
) {
  const name = `Dashboard ${index}`;
  return database.customer.create({
    data: withCustomerIndexFields({
      companyId,
      personType: "LEGAL",
      documentType: "CUIT",
      documentNumber: `30${String(index).padStart(9, "0")}`,
      legalName: name,
      commercialName: name,
      contactName: name,
      email: `dashboard-${index}@e2e.operia.invalid`,
      phone: "11111111",
      address: "E2E",
      city: "Buenos Aires",
      fiscalAddress: "E2E",
      locality: "Centro",
      postalCode: "1000",
      province: "Buenos Aires",
      priceList: "General",
      status: "ACTIVE",
      vatCondition: "FINAL_CONSUMER",
    } satisfies Prisma.CustomerUncheckedCreateInput),
  });
}

export async function createDashboardProduct(
  database: Pick<DatabaseService, "product" | "elemSubType">,
  companyId: string,
  options: { index: number; status?: "ACTIVE" | "INACTIVE"; stock?: number; minimum?: number },
) {
  const categoryId = `e2e-dashboard-cat-${companyId}`;
  await database.elemSubType.upsert({
    where: { id_companyId: { id: categoryId, companyId } },
    update: {},
    create: {
      id: categoryId,
      companyId,
      elemTypeId: "PROD_CAT",
      description: "E2E Dashboard",
      descriptionNormalized: "e2e dashboard",
    },
  });
  const name = `Producto Dashboard ${options.index}`;
  return database.product.create({
    data: {
      companyId,
      sku: `DASH-${options.index}`,
      name,
      categoryId,
      unit: "unidad",
      costCents: 100,
      priceCents: 200,
      minimumStock: options.minimum ?? 2,
      stockOnHand: options.stock ?? 1,
      status: options.status ?? "ACTIVE",
      searchText: name,
      nameNormalized: name.toLowerCase(),
    },
  });
}
