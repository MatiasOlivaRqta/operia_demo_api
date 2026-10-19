import { describe, expect, it } from "vitest";
import type { Customer } from "../generated/prisma/client.js";
import {
  mapCustomerCreateInputToPersistence,
  mapCustomerInputToPersistence,
  mapCustomerToDto,
} from "./customer.mapper.js";

const row: Customer = {
  id: "customer-1",
  companyId: "operia-central",
  personType: "LEGAL",
  documentType: "CUIT",
  documentNumber: "30714589632",
  legalName: "Distribuidora Norte S.R.L.",
  commercialName: "Distribuidora Norte",
  contactName: "Luciana Perez",
  email: "compras@distribuidoranorte.com.ar",
  phone: "+54 11 4555-0128",
  address: "Av. Rivadavia 4520",
  city: "Ciudad de Buenos Aires",
  fiscalAddress: "Av. Rivadavia 4520, Piso 4",
  locality: "Almagro",
  postalCode: "C1205",
  province: "Ciudad Autónoma de Buenos Aires",
  priceList: "Mayorista",
  status: "INACTIVE",
  vatCondition: "REGISTERED_TAXPAYER",
  searchText: "",
  nameNormalized: "",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const legalInput = {
  address: "Av. Prueba 123",
  city: "CABA",
  commercialName: "Prueba",
  contactEmail: "contacto@example.test",
  contactName: "Lucía Pérez",
  contactPhone: "123456",
  documentNumber: "30-71458963-2",
  documentType: "CUIT/CUIL",
  fiscalAddress: "Av. Prueba 123",
  legalName: "Prueba S.R.L.",
  locality: "Centro",
  personType: "Jurídica",
  postalCode: "1000",
  priceList: "Mayorista",
  province: "Buenos Aires",
  status: "active",
  vatCondition: "Responsable inscripto",
} as const;

describe("mapCustomerToDto", () => {
  it("maps legal documents and enums to the API contract", () => {
    expect(mapCustomerToDto(row)).toMatchObject({
      documentNumber: "30-71458963-2",
      documentType: "CUIT/CUIL",
      personType: "Jurídica",
      status: "inactive",
      vatCondition: "Responsable inscripto",
    });
    expect(mapCustomerToDto(row)).not.toHaveProperty("movements");
  });

  it("returns DNI and passport numbers without CUIT formatting", () => {
    expect(
      mapCustomerToDto({
        ...row,
        personType: "NATURAL",
        documentType: "DNI",
        documentNumber: "30123456",
      }),
    ).toMatchObject({
      documentNumber: "30123456",
      documentType: "DNI",
      personType: "Física",
    });
    expect(
      mapCustomerToDto({
        ...row,
        personType: "NATURAL",
        documentType: "PASSPORT",
        documentNumber: "AB123456",
      }),
    ).toMatchObject({
      documentNumber: "AB123456",
      documentType: "Pasaporte",
      personType: "Física",
    });
  });
});

describe("mapCustomerInputToPersistence", () => {
  it("maps legal fields, document and enum labels to persistence values", () => {
    expect(mapCustomerInputToPersistence(legalInput)).toMatchObject({
      documentNumber: "30714589632",
      documentType: "CUIT",
      personType: "LEGAL",
      email: legalInput.contactEmail,
      phone: legalInput.contactPhone,
      status: "ACTIVE",
      vatCondition: "REGISTERED_TAXPAYER",
      searchText: "prueba s.r.l. prueba lucia perez contacto@example.test 123456 30714589632",
      nameNormalized: "prueba",
    });
  });

  it("builds normalized search fields when creating a customer", () => {
    const result = mapCustomerCreateInputToPersistence(legalInput);
    expect(result.searchText).toBe(
      "prueba s.r.l. prueba lucia perez contacto@example.test 123456 30714589632",
    );
    expect(result.nameNormalized).toBe("prueba");
  });

  it("rebuilds normalized search fields when editing a customer", () => {
    const result = mapCustomerInputToPersistence({
      ...legalInput,
      commercialName: "Compañía Pérez",
      legalName: "Compañía Pérez S.R.L.",
      documentNumber: "30-71458963-2",
    });
    expect(result.searchText).toBe(
      "compania perez s.r.l. compania perez lucia perez contacto@example.test 123456 30714589632",
    );
    expect(result.nameNormalized).toBe("compania perez");
  });

  it("defaults city to an empty string when creating without one", () => {
    const withoutCity = omitCity(legalInput);
    expect(mapCustomerCreateInputToPersistence(withoutCity)).toHaveProperty("city", "");
  });

  it("omits city when updating without one", () => {
    const withoutCity = omitCity(legalInput);
    expect(mapCustomerInputToPersistence(withoutCity)).not.toHaveProperty("city");
  });

  it("normalizes a physical DNI and clears fields that do not apply", () => {
    const data = mapCustomerInputToPersistence({
      ...legalInput,
      address: "",
      city: "",
      commercialName: "ignored",
      contactEmail: "",
      contactName: "ignored",
      contactPhone: "11223344",
      documentNumber: "30.123.456",
      documentType: "DNI",
      fiscalAddress: "ignored",
      legalName: "María Pérez",
      locality: "ignored",
      personType: "Física",
      postalCode: "",
      priceList: "Minorista",
      province: "",
      vatCondition: "Consumidor final",
    });
    expect(data).toMatchObject({
      documentNumber: "30123456",
      documentType: "DNI",
      personType: "NATURAL",
      commercialName: "María Pérez",
      contactName: "",
      fiscalAddress: "",
      locality: "ignored",
    });
  });

  it("preserves locality for a physical customer", () => {
    const data = mapCustomerInputToPersistence({
      ...legalInput,
      personType: "Física",
      documentType: "DNI",
      documentNumber: "30.123.456",
      contactPhone: "11223344",
      vatCondition: "Consumidor final",
      locality: "Villa Carlos Paz",
    });
    expect(data.locality).toBe("Villa Carlos Paz");
  });

  it("normalizes passports to uppercase and removes spaces", () => {
    const data = mapCustomerInputToPersistence({
      ...legalInput,
      documentNumber: "ab 123456",
      documentType: "Pasaporte",
      personType: "Física",
      contactPhone: "11223344",
      vatCondition: "Consumidor final",
    });
    expect(data.documentNumber).toBe("AB123456");
  });
});

function omitCity<T extends { city?: string }>(value: T): Omit<T, "city"> {
  const result = { ...value };
  delete result.city;
  return result;
}
