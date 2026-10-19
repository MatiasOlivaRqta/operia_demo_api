-- Prisma does not represent partial indexes; preserve this index even though prisma migrate diff reports it as schema drift.
CREATE INDEX "products_company_id_name_normalized_id_low_stock_idx"
ON "products" ("company_id", "name_normalized", "id")
WHERE "stock_on_hand" <= "minimum_stock";
