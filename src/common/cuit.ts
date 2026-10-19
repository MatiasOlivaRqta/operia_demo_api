export function normalizeCuit(value: string): string {
  return value.replaceAll(/\D/g, "");
}

export function formatCuit(value: string): string {
  const digits = normalizeCuit(value);
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

export function isValidCuit(value: string): boolean {
  const digits = normalizeCuit(value);
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0);
  const checkDigit = 11 - (sum % 11);
  const expected = checkDigit === 11 ? 0 : checkDigit === 10 ? 9 : checkDigit;
  return Number(digits[10]) === expected;
}
