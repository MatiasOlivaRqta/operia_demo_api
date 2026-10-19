-- Catálogo de tipos/subtipos y categoría de producto como referencia (product-categories).
CREATE TABLE "elem_types" (
    "id" VARCHAR(50) NOT NULL,
    "description" VARCHAR(100) NOT NULL,
    CONSTRAINT "elem_types_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "elem_sub_types" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "elem_type_id" VARCHAR(50) NOT NULL,
    "description" VARCHAR(100) NOT NULL,
    "description_normalized" VARCHAR(100) NOT NULL,
    CONSTRAINT "elem_sub_types_pkey" PRIMARY KEY ("id","company_id")
);

CREATE UNIQUE INDEX "elem_sub_types_company_type_desc_key"
  ON "elem_sub_types"("company_id", "elem_type_id", "description_normalized");

ALTER TABLE "elem_sub_types" ADD CONSTRAINT "elem_sub_types_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "elem_sub_types" ADD CONSTRAINT "elem_sub_types_elem_type_id_fkey"
  FOREIGN KEY ("elem_type_id") REFERENCES "elem_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Dato de esquema (no de ejemplo): la FK de los subtipos lo exige y no hay seeder de elem_types.
INSERT INTO "elem_types" ("id", "description") VALUES ('PROD_CAT', 'Categorías de producto');

ALTER TABLE "products" ADD COLUMN "category_id" TEXT;

-- Normalización equivalente a normalizeSearch para español: minúsculas, sin tildes y espacios compactados.
CREATE FUNCTION pg_temp.norm_cat(value TEXT) RETURNS TEXT AS $$
  SELECT regexp_replace(
    translate(lower(btrim(value)), 'áéíóúüñ', 'aeiouun'),
    '\s+', ' ', 'g')
$$ LANGUAGE sql IMMUTABLE;

-- Una fila por (empresa, descripción normalizada): variante más usada, desempate alfabético.
INSERT INTO "elem_sub_types" ("id", "company_id", "elem_type_id", "description", "description_normalized")
SELECT gen_random_uuid()::text, company_id, 'PROD_CAT', description, normalized
FROM (
  SELECT DISTINCT ON (company_id, normalized)
    company_id, description, normalized
  FROM (
    SELECT company_id, btrim(category) AS description, pg_temp.norm_cat(category) AS normalized, count(*) AS uses
    FROM "products"
    GROUP BY company_id, btrim(category), pg_temp.norm_cat(category)
  ) variants
  ORDER BY company_id, normalized, uses DESC, description ASC
) chosen;

UPDATE "products" p
SET "category_id" = s."id"
FROM "elem_sub_types" s
WHERE s."company_id" = p."company_id"
  AND s."elem_type_id" = 'PROD_CAT'
  AND s."description_normalized" = pg_temp.norm_cat(p."category");

ALTER TABLE "products" ALTER COLUMN "category_id" SET NOT NULL;
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_company_id_fkey"
  FOREIGN KEY ("category_id", "company_id") REFERENCES "elem_sub_types"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "products_category_id_company_id_idx" ON "products"("category_id", "company_id");
ALTER TABLE "products" DROP COLUMN "category";
