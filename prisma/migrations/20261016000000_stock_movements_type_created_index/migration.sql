CREATE INDEX "stock_movements_company_id_type_created_at_id_idx" ON "stock_movements"("company_id", "type", "created_at" DESC, "id" DESC);
