export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .trim();
}

export function buildProductIndexFields(input: {
  name: string;
  sku: string;
  barcode: string;
  category: string;
}): { searchText: string; nameNormalized: string } {
  return {
    searchText: normalizeSearch([input.name, input.sku, input.barcode, input.category].join(" ")),
    nameNormalized: normalizeSearch(input.name),
  };
}

export function buildCustomerIndexFields(input: {
  legalName: string;
  commercialName: string;
  contactName: string;
  email: string;
  phone: string;
  documentNumber: string;
}): { searchText: string; nameNormalized: string } {
  return {
    searchText: normalizeSearch(
      [
        input.legalName,
        input.commercialName,
        input.contactName,
        input.email,
        input.phone,
        input.documentNumber,
      ].join(" "),
    ),
    nameNormalized: normalizeSearch(input.commercialName),
  };
}
