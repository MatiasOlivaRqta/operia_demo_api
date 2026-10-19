import type { Prisma } from "../../src/generated/prisma/client.js";
import { buildCustomerIndexFields } from "../../src/common/search.js";
import type { DatabaseService } from "../../src/database/database.service.js";

type CustomerIndexSource = Pick<
  Prisma.CustomerUncheckedCreateInput,
  "legalName" | "commercialName" | "contactName" | "email" | "phone" | "documentNumber"
>;

export function withCustomerIndexFields<T extends CustomerIndexSource>(
  data: T,
): T & ReturnType<typeof buildCustomerIndexFields> {
  return {
    ...data,
    ...buildCustomerIndexFields({
      legalName: data.legalName,
      commercialName: data.commercialName,
      contactName: data.contactName,
      email: data.email,
      phone: data.phone,
      documentNumber: data.documentNumber,
    }),
  };
}

export function createTestCustomer<T extends Prisma.CustomerCreateArgs>(
  database: Pick<DatabaseService, "customer">,
  args: T,
) {
  const data = args.data as Prisma.CustomerUncheckedCreateInput;
  return database.customer.create({ ...args, data: withCustomerIndexFields(data) });
}
