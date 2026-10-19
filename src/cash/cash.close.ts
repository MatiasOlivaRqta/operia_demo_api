export type CashClose = {
  theoretical: number;
  difference: number;
  observationRequired: boolean;
};

export function calculateCashClose({
  openingBalance,
  cashCollected,
  declared,
}: {
  openingBalance: number;
  cashCollected: number;
  declared: number;
}): CashClose {
  for (const amount of [openingBalance, cashCollected, declared]) {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new RangeError("Los importes deben ser enteros no negativos.");
  }
  const theoretical = openingBalance + cashCollected;
  const difference = declared - theoretical;
  if (!Number.isSafeInteger(theoretical) || !Number.isSafeInteger(difference))
    throw new RangeError("El cierre excede el rango de enteros.");
  return { theoretical, difference, observationRequired: difference !== 0 };
}

export function isCashCloseObservationValid(
  close: CashClose,
  observation?: string | null,
): boolean {
  return !close.observationRequired || (observation?.trim().length ?? 0) > 0;
}
