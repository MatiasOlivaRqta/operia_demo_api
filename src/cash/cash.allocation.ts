export type PendingDocument = {
  documentId: string;
  pending: number;
};

export type CashAllocation = {
  applications: { documentId: string; amount: number }[];
  creditGenerated: number;
};

/** The caller supplies pending documents in created_at, id order. */
export function allocate(
  amount: number,
  pendingDocs: readonly PendingDocument[],
  targetDocumentId?: string,
): CashAllocation {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new RangeError("El importe debe ser un entero seguro positivo.");
  const ids = new Set<string>();
  for (const document of pendingDocs) {
    if (!Number.isSafeInteger(document.pending) || document.pending < 0)
      throw new RangeError("El pendiente debe ser un entero seguro no negativo.");
    if (ids.has(document.documentId)) throw new RangeError("Comprobante duplicado.");
    ids.add(document.documentId);
  }
  if (targetDocumentId !== undefined && !ids.has(targetDocumentId))
    throw new RangeError("El comprobante objetivo no está entre los pendientes.");

  const applications: CashAllocation["applications"] = [];
  let remaining = amount;
  for (const document of pendingDocs) {
    if (targetDocumentId !== undefined && document.documentId !== targetDocumentId) continue;
    const applied = Math.min(remaining, document.pending);
    if (applied > 0) applications.push({ documentId: document.documentId, amount: applied });
    remaining -= applied;
    if (remaining === 0) break;
  }
  return { applications, creditGenerated: remaining };
}
