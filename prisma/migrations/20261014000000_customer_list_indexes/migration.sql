ALTER TABLE "customers"
ADD COLUMN "search_text" TEXT NOT NULL DEFAULT '',
ADD COLUMN "name_normalized" TEXT NOT NULL DEFAULT '';

UPDATE "customers"
SET
  "search_text" = btrim(
    translate(
      lower(
        concat_ws(
          ' ',
          "legal_name",
          "commercial_name",
          "contact_name",
          "contact_email",
          "contact_phone",
          regexp_replace("document_number", '[-.]', '', 'g')
        )
      ),
      'áàäâãéèëêíìïîóòöôõúùüûñç',
      'aaaaaeeeeiiiiooooouuuunc'
    )
  ),
  "name_normalized" = btrim(
    translate(
      lower("commercial_name"),
      'áàäâãéèëêíìïîóòöôõúùüûñç',
      'aaaaaeeeeiiiiooooouuuunc'
    )
  );

DROP INDEX "customers_company_id_status_idx";

CREATE INDEX "customers_company_id_name_normalized_id_idx"
ON "customers"("company_id", "name_normalized", "id");

CREATE INDEX "customers_company_id_status_name_normalized_id_idx"
ON "customers"("company_id", "status", "name_normalized", "id");

CREATE INDEX "customers_company_id_vat_condition_name_normalized_id_idx"
ON "customers"("company_id", "vat_condition", "name_normalized", "id");

CREATE INDEX "customers_search_text_trgm_idx"
ON "customers" USING GIN ("search_text" gin_trgm_ops);
