import { describe, expect, it } from "vitest";
import { customerQuerySchema, customerSchema } from "./customer.schemas.js";

const physical = {
  documentNumber: "30.123.456",
  documentType: "DNI",
  legalName: "María Pérez",
  personType: "Física",
  priceList: "Minorista",
  status: "active",
  vatCondition: "Consumidor final",
  contactPhone: "1123456789",
} as const;

const legal = {
  address: "Av. Siempreviva 123",
  city: "CABA",
  commercialName: "Compañía",
  contactEmail: "contacto@example.test",
  contactName: "Ana Pérez",
  contactPhone: "1123456789",
  documentNumber: "30-71458963-2",
  documentType: "CUIT/CUIL",
  fiscalAddress: "Av. Siempreviva 123",
  legalName: "Compañía S.R.L.",
  locality: "Centro",
  personType: "Jurídica",
  postalCode: "1000",
  priceList: "Mayorista",
  province: "Buenos Aires",
  status: "active",
  vatCondition: "Responsable inscripto",
} as const;

function fieldsFor(
  error: ReturnType<typeof customerSchema.safeParse> extends infer R
    ? R extends { success: false; error: { issues: Array<{ path: PropertyKey[] }> } }
      ? R["error"]["issues"]
      : never
    : never,
) {
  return error.map((issue) => issue.path[0]);
}

describe("customerSchema", () => {
  it("requires a person type", () => {
    const input = { ...physical, personType: undefined };
    const result = customerSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldsFor(result.error.issues)).toContain("personType");
  });

  it("accepts a physical customer with a phone and optional address fields", () => {
    expect(customerSchema.parse(physical)).toMatchObject({
      address: "",
      commercialName: "",
      fiscalAddress: "",
      locality: "",
      postalCode: "",
      province: "",
    });
  });

  it("requires a phone or email for a physical customer", () => {
    const result = customerSchema.safeParse({ ...physical, contactPhone: undefined });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(fieldsFor(result.error.issues)).toContain("contactPhone");
      expect(result.error.issues.map(({ message }) => message)).toContain(
        "validation.customer.phoneOrEmail",
      );
    }
  });

  it("accepts a physical customer with email instead of phone", () => {
    expect(
      customerSchema.safeParse({ ...physical, contactPhone: "", contactEmail: "a@example.test" })
        .success,
    ).toBe(true);
  });

  it("rejects an invalid optional email", () => {
    const result = customerSchema.safeParse({ ...physical, contactEmail: "inválido" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldsFor(result.error.issues)).toContain("contactEmail");
  });

  it("accepts DNI with periods and rejects a DNI outside 7–8 digits", () => {
    expect(customerSchema.safeParse(physical).success).toBe(true);
    const result = customerSchema.safeParse({ ...physical, documentNumber: "123456" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldsFor(result.error.issues)).toContain("documentNumber");
  });

  it("rejects a CUIT with an invalid check digit", () => {
    const result = customerSchema.safeParse({ ...legal, documentNumber: "20-12345678-0" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldsFor(result.error.issues)).toContain("documentNumber");
  });

  it("accepts a valid passport and rejects values outside 6–20 alphanumeric characters", () => {
    expect(
      customerSchema.safeParse({
        ...physical,
        documentType: "Pasaporte",
        documentNumber: "ab123456",
      }).success,
    ).toBe(true);
    const result = customerSchema.safeParse({
      ...physical,
      documentType: "Pasaporte",
      documentNumber: "abc-123",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldsFor(result.error.issues)).toContain("documentNumber");
  });

  it("requires CUIT/CUIL for a legal customer", () => {
    const result = customerSchema.safeParse({
      ...legal,
      documentType: "DNI",
      documentNumber: "30123456",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldsFor(result.error.issues)).toContain("documentType");
  });

  it("requires all company fields for a legal customer", () => {
    const result = customerSchema.safeParse({ ...legal, fiscalAddress: "" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldsFor(result.error.issues)).toContain("fiscalAddress");
  });

  it("accepts a legal customer without a city", () => {
    const withoutCity = omitCity(legal);
    expect(customerSchema.safeParse(withoutCity).success).toBe(true);
  });

  it("requires the legal name, price list, VAT condition, and status", () => {
    for (const [field, value] of [
      ["legalName", ""],
      ["priceList", ""],
      ["vatCondition", "invalid"],
      ["status", "invalid"],
    ]) {
      const result = customerSchema.safeParse({ ...physical, [field]: value });
      expect(result.success, field).toBe(false);
    }
  });

  it("rejects unknown fields", () => {
    expect(customerSchema.safeParse({ ...physical, unknown: true }).success).toBe(false);
  });
});

describe("customerQuerySchema", () => {
  it("defaults to the first page with 25 items", () => {
    expect(customerQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 25 });
  });

  it.each([
    { pageSize: "101" },
    { page: "0" },
    { vatCondition: "Otro" },
    { search: "x".repeat(201) },
  ])("rejects invalid list query parameters", (query) => {
    expect(customerQuerySchema.safeParse(query).success).toBe(false);
  });
});

function omitCity<T extends { city?: string }>(value: T): Omit<T, "city"> {
  const result = { ...value };
  delete result.city;
  return result;
}
