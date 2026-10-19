-- CreateEnum
CREATE TYPE "cash_session_status" AS ENUM ('O', 'C');
CREATE TYPE "cash_movement_type" AS ENUM ('C');
CREATE TYPE "cash_payment_method" AS ENUM ('CASH', 'TRANSFER', 'CARD');

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "status" "cash_session_status" NOT NULL DEFAULT 'O',
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "opened_by_user_id" UUID NOT NULL,
    "closed_by_user_id" UUID,
    "operator_name" TEXT NOT NULL,
    "opening_balance" INTEGER NOT NULL,
    "declared_balance" BIGINT,
    "theoretical_balance" BIGINT,
    "difference" BIGINT,
    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id", "company_id"),
    CONSTRAINT "cash_sessions_opening_balance_check" CHECK ("opening_balance" >= 0)
);

CREATE TABLE "cash_movements" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "type" "cash_movement_type" NOT NULL,
    "payment_method" "cash_payment_method" NOT NULL,
    "customer_id" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "document_id" TEXT,
    "document_number" TEXT,
    "receipt_number" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id", "company_id"),
    CONSTRAINT "cash_movements_amount_check" CHECK ("amount" > 0)
);

CREATE TABLE "receipt_counters" (
    "company_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL,
    CONSTRAINT "receipt_counters_pkey" PRIMARY KEY ("company_id")
);

-- CreateIndex
CREATE INDEX "cash_sessions_company_id_idx" ON "cash_sessions"("company_id");
CREATE UNIQUE INDEX "cash_sessions_one_open_per_company_idx" ON "cash_sessions"("company_id") WHERE "status" = 'O';
CREATE UNIQUE INDEX "cash_movements_company_id_receipt_number_key" ON "cash_movements"("company_id", "receipt_number");
CREATE INDEX "cash_movements_company_id_created_at_id_idx" ON "cash_movements"("company_id", "created_at" DESC, "id" DESC);
CREATE INDEX "cash_movements_company_id_session_id_created_at_id_idx" ON "cash_movements"("company_id", "session_id", "created_at" DESC, "id" DESC);
CREATE INDEX "cash_movements_company_id_session_id_payment_method_idx" ON "cash_movements"("company_id", "session_id", "payment_method");

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_opened_by_user_id_fkey" FOREIGN KEY ("opened_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_session_id_company_id_fkey" FOREIGN KEY ("session_id", "company_id") REFERENCES "cash_sessions"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_customer_id_company_id_fkey" FOREIGN KEY ("customer_id", "company_id") REFERENCES "customers"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_document_id_company_id_fkey" FOREIGN KEY ("document_id", "company_id") REFERENCES "documents"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipt_counters" ADD CONSTRAINT "receipt_counters_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
