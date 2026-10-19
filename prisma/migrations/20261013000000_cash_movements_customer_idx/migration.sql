CREATE INDEX "cash_movements_company_id_customer_id_created_at_idx"
ON "cash_movements" ("company_id", "customer_id", "created_at" DESC);
