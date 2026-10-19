-- CreateIndex
-- Serves the default product list (ORDER BY name_normalized, id without a status filter).
-- The (company_id, status, name_normalized, id) index cannot provide that order because
-- status sits between the equality column and the sort columns.
CREATE INDEX "products_company_id_name_normalized_id_idx" ON "products"("company_id", "name_normalized", "id");
