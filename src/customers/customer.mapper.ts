import type { Customer } from "../generated/prisma/client.js";
import { formatCuit, normalizeCuit } from "../common/cuit.js";
import { buildCustomerIndexFields } from "../common/search.js";
import type { CustomerInput } from "./customer.schemas.js";

export type CustomerDto = {
  address: string;
  city: string;
  commercialName: string;
  companyId: string;
  contactEmail: string;
  contactName: string;
  contactPhone: string;
  documentNumber: string;
  documentType: "DNI" | "CUIT/CUIL" | "Pasaporte";
  fiscalAddress: string;
  id: string;
  legalName: string;
  locality: string;
  personType: "Física" | "Jurídica";
  postalCode: string;
  priceList: string;
  province: string;
  status: "active" | "inactive";
  vatCondition: "Consumidor final" | "Exento" | "Monotributista" | "Responsable inscripto";
};

export type CustomerListItemDto = CustomerDto & { balanceCents: number };

const vatConditionLabels = {
  FINAL_CONSUMER: "Consumidor final",
  EXEMPT: "Exento",
  MONOTRIBUTISTA: "Monotributista",
  REGISTERED_TAXPAYER: "Responsable inscripto",
} as const;

const vatConditionValues = {
  "Consumidor final": "FINAL_CONSUMER",
  Exento: "EXEMPT",
  Monotributista: "MONOTRIBUTISTA",
  "Responsable inscripto": "REGISTERED_TAXPAYER",
} as const;

type CustomerDtoSource = Pick<
  Customer,
  | "id"
  | "companyId"
  | "address"
  | "city"
  | "commercialName"
  | "email"
  | "contactName"
  | "phone"
  | "documentNumber"
  | "documentType"
  | "fiscalAddress"
  | "legalName"
  | "locality"
  | "personType"
  | "postalCode"
  | "priceList"
  | "province"
  | "status"
  | "vatCondition"
>;

export function mapCustomerToDto(row: CustomerDtoSource): CustomerDto {
  return {
    address: row.address,
    city: row.city,
    commercialName: row.commercialName,
    companyId: row.companyId,
    contactEmail: row.email,
    contactName: row.contactName,
    contactPhone: row.phone,
    documentNumber:
      row.documentType === "CUIT" ? formatCuit(row.documentNumber) : row.documentNumber,
    documentType:
      row.documentType === "CUIT"
        ? "CUIT/CUIL"
        : row.documentType === "PASSPORT"
          ? "Pasaporte"
          : "DNI",
    fiscalAddress: row.fiscalAddress,
    id: row.id,
    legalName: row.legalName,
    locality: row.locality,
    personType: row.personType === "NATURAL" ? "Física" : "Jurídica",
    postalCode: row.postalCode,
    priceList: row.priceList,
    province: row.province,
    status: row.status === "ACTIVE" ? "active" : "inactive",
    vatCondition: vatConditionLabels[row.vatCondition],
  };
}

export function normalizeDocumentNumber(
  type: CustomerInput["documentType"],
  value: string,
): string {
  if (type === "CUIT/CUIL" || type === "DNI") return normalizeCuit(value);
  return value.trim().replaceAll(" ", "").toUpperCase();
}

export function mapCustomerInputToPersistence(input: CustomerInput) {
  const { contactEmail, contactPhone, ...rest } = input;
  const isNatural = input.personType === "Física";
  const persistenceData = {
    ...rest,
    personType: isNatural ? ("NATURAL" as const) : ("LEGAL" as const),
    documentType:
      input.documentType === "CUIT/CUIL"
        ? ("CUIT" as const)
        : input.documentType === "Pasaporte"
          ? ("PASSPORT" as const)
          : ("DNI" as const),
    documentNumber: normalizeDocumentNumber(input.documentType, input.documentNumber),
    commercialName: isNatural ? input.legalName : input.commercialName,
    contactName: isNatural ? "" : input.contactName,
    fiscalAddress: isNatural ? "" : input.fiscalAddress,
    locality: input.locality,
    email: contactEmail,
    phone: contactPhone,
    status: input.status === "active" ? ("ACTIVE" as const) : ("INACTIVE" as const),
    vatCondition: vatConditionValues[input.vatCondition],
  };
  return {
    ...persistenceData,
    ...buildCustomerIndexFields({
      legalName: persistenceData.legalName,
      commercialName: persistenceData.commercialName,
      contactName: persistenceData.contactName,
      email: persistenceData.email,
      phone: persistenceData.phone,
      documentNumber: persistenceData.documentNumber,
    }),
  };
}

export function mapCustomerCreateInputToPersistence(input: CustomerInput) {
  return {
    ...mapCustomerInputToPersistence(input),
    city: input.city ?? "",
  };
}
