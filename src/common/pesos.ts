export function formatPesos(cents: number | bigint): string {
  if (typeof cents === "number" && !Number.isSafeInteger(cents))
    throw new RangeError("El importe debe ser un entero seguro de centavos.");
  const value = BigInt(cents);
  const absolute = value < 0n ? -value : value;
  const pesos = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const decimals = (absolute % 100n).toString().padStart(2, "0");
  return `${value < 0n ? "-" : ""}$${pesos},${decimals}`;
}
