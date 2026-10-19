import type { DatabaseService } from "../../src/database/database.service.js";

// Crea o reutiliza la categoría de prueba de una empresa; el id fijo permite limpiarla por prefijo.
export async function ensureProductCategory(
  database: Pick<DatabaseService, "elemSubType">,
  companyId: string,
  description = "E2E",
): Promise<string> {
  const id = `e2e-cat-${companyId}`;
  await database.elemSubType.upsert({
    where: { id_companyId: { id, companyId } },
    update: {},
    create: {
      id,
      companyId,
      elemTypeId: "PROD_CAT",
      description,
      descriptionNormalized: description.toLowerCase(),
    },
  });
  return id;
}
