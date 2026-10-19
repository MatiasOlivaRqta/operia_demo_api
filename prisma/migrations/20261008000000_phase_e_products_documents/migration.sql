-- CreateEnum
CREATE TYPE "product_status" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "stock_movement_type" AS ENUM ('INGRESO', 'SALIDA', 'AJUSTE', 'REVERSION');
CREATE TYPE "document_status" AS ENUM ('COMPLETED', 'CANCELLED');

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "cost_cents" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "minimum_stock" INTEGER NOT NULL,
    "stock_on_hand" INTEGER NOT NULL,
    "status" "product_status" NOT NULL,
    "search_text" TEXT NOT NULL,
    "name_normalized" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "products_pkey" PRIMARY KEY ("id","company_id"),
    CONSTRAINT "products_stock_on_hand_check" CHECK ("stock_on_hand" >= 0),
    CONSTRAINT "products_cost_cents_check" CHECK ("cost_cents" >= 0),
    CONSTRAINT "products_price_cents_check" CHECK ("price_cents" >= 0),
    CONSTRAINT "products_minimum_stock_check" CHECK ("minimum_stock" >= 0)
);

CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "type" "stock_movement_type" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "document_id" TEXT,
    "reverses_movement_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id","company_id"),
    CONSTRAINT "stock_movements_quantity_check" CHECK ("quantity" <> 0)
);

CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "internal_number" TEXT NOT NULL,
    "point_of_sale" TEXT NOT NULL DEFAULT '0001',
    "status" "document_status" NOT NULL,
    "cancellation_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "total_cents" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "search_text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "documents_pkey" PRIMARY KEY ("id","company_id"),
    CONSTRAINT "documents_total_cents_check" CHECK ("total_cents" >= 0)
);

CREATE TABLE "document_items" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "discount_rate" DECIMAL(5,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    CONSTRAINT "document_items_pkey" PRIMARY KEY ("id","company_id"),
    CONSTRAINT "document_items_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "document_items_unit_price_cents_check" CHECK ("unit_price_cents" >= 0),
    CONSTRAINT "document_items_discount_rate_check" CHECK ("discount_rate" BETWEEN 0 AND 100),
    CONSTRAINT "document_items_tax_rate_check" CHECK ("tax_rate" BETWEEN 0 AND 100)
);

CREATE TABLE "document_counters" (
    "company_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL,
    CONSTRAINT "document_counters_pkey" PRIMARY KEY ("company_id")
);

CREATE UNIQUE INDEX "products_company_id_lower_sku_key" ON "products"("company_id", lower("sku"));
CREATE INDEX "products_company_id_status_name_normalized_id_idx" ON "products"("company_id", "status", "name_normalized", "id");
CREATE INDEX "products_search_text_trgm_idx" ON "products" USING GIN ("search_text" gin_trgm_ops);
CREATE INDEX "stock_movements_company_id_product_id_created_at_id_idx" ON "stock_movements"("company_id", "product_id", "created_at" DESC, "id" DESC);
CREATE INDEX "stock_movements_company_id_created_at_id_idx" ON "stock_movements"("company_id", "created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "stock_movements_company_id_reverses_movement_id_key" ON "stock_movements"("company_id", "reverses_movement_id");
CREATE INDEX "documents_company_id_created_at_id_idx" ON "documents"("company_id", "created_at" DESC, "id" DESC);
CREATE INDEX "documents_company_id_customer_id_created_at_idx" ON "documents"("company_id", "customer_id", "created_at" DESC);
CREATE UNIQUE INDEX "documents_company_id_internal_number_key" ON "documents"("company_id", "internal_number");
CREATE UNIQUE INDEX "documents_company_id_idempotency_key_key" ON "documents"("company_id", "idempotency_key");
CREATE INDEX "documents_search_text_trgm_idx" ON "documents" USING GIN ("search_text" gin_trgm_ops);
CREATE INDEX "document_items_company_id_document_id_position_idx" ON "document_items"("company_id", "document_id", "position");

ALTER TABLE "products" ADD CONSTRAINT "products_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_company_id_fkey" FOREIGN KEY ("product_id", "company_id") REFERENCES "products"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_customer_id_company_id_fkey" FOREIGN KEY ("customer_id", "company_id") REFERENCES "customers"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_items" ADD CONSTRAINT "document_items_document_id_company_id_fkey" FOREIGN KEY ("document_id", "company_id") REFERENCES "documents"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;
