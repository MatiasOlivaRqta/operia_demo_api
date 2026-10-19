export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.floor(Math.abs(value) + 0.5) : Math.floor(value + 0.5);
}

export function percentOf(cents: number, percentage: number): number {
  return roundHalfUp((cents * percentage) / 100);
}

export type DocumentItemAmounts = {
  quantity: number;
  unitPriceCents: number;
  discountRate: number;
  taxRate: number;
};

export function calculateItemSubtotal(item: DocumentItemAmounts): number {
  return roundHalfUp(item.quantity * item.unitPriceCents);
}

export function calculateItemDiscount(item: DocumentItemAmounts): number {
  return percentOf(calculateItemSubtotal(item), item.discountRate);
}

export function calculateItemTax(item: DocumentItemAmounts): number {
  return percentOf(
    roundHalfUp(calculateItemSubtotal(item) - calculateItemDiscount(item)),
    item.taxRate,
  );
}

export function calculateDocumentTotal(items: readonly DocumentItemAmounts[]): number {
  return roundHalfUp(
    items.reduce(
      (total, item) =>
        total + calculateItemSubtotal(item) - calculateItemDiscount(item) + calculateItemTax(item),
      0,
    ),
  );
}
