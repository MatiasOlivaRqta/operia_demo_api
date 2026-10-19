-- AlterTable
ALTER TABLE "cash_sessions" ADD COLUMN "observation" TEXT;
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_close_consistency_check" CHECK (
    ("status" = 'O' AND "closed_at" IS NULL AND "closed_by_user_id" IS NULL
        AND "declared_balance" IS NULL AND "theoretical_balance" IS NULL AND "difference" IS NULL)
    OR ("status" = 'C' AND "closed_at" IS NOT NULL AND "closed_by_user_id" IS NOT NULL
        AND "declared_balance" IS NOT NULL AND "theoretical_balance" IS NOT NULL AND "difference" IS NOT NULL)
);
ALTER TABLE "cash_movements" ADD COLUMN "idempotency_key" TEXT, ADD COLUMN "request_fingerprint" TEXT;

-- CreateEnum
CREATE TYPE "account_entry_type" AS ENUM ('P', 'G', 'A');
CREATE TYPE "mail_outbox_status" AS ENUM ('P', 'S', 'F');
CREATE TYPE "mail_outbox_type" AS ENUM ('CASH_CLOSE_DIFFERENCE');

-- CreateTable
CREATE TABLE "account_entries" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "type" "account_entry_type" NOT NULL,
    "amount" INTEGER NOT NULL,
    "document_id" TEXT,
    "cash_movement_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_entries_pkey" PRIMARY KEY ("id", "company_id"),
    CONSTRAINT "account_entries_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "account_entries_type_references_check" CHECK (
        ("type" = 'P' AND "document_id" IS NOT NULL AND "cash_movement_id" IS NOT NULL)
        OR ("type" = 'G' AND "document_id" IS NULL AND "cash_movement_id" IS NOT NULL)
        OR ("type" = 'A' AND "document_id" IS NOT NULL AND "cash_movement_id" IS NULL)
    )
);

CREATE TABLE "mail_outbox" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "type" "mail_outbox_type" NOT NULL,
    "notification_key" TEXT NOT NULL,
    "recipients" TEXT[] NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "mail_outbox_status" NOT NULL DEFAULT 'P',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mail_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_movements_company_id_idempotency_key_key" ON "cash_movements"("company_id", "idempotency_key");
CREATE INDEX "account_entries_company_id_customer_id_created_at_idx" ON "account_entries"("company_id", "customer_id", "created_at");
CREATE INDEX "account_entries_company_id_document_id_idx" ON "account_entries"("company_id", "document_id") WHERE "document_id" IS NOT NULL;
CREATE INDEX "account_entries_company_id_cash_movement_id_idx" ON "account_entries"("company_id", "cash_movement_id");
CREATE UNIQUE INDEX "mail_outbox_notification_key_key" ON "mail_outbox"("notification_key");
CREATE INDEX "mail_outbox_status_next_attempt_at_idx" ON "mail_outbox"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_customer_id_company_id_fkey" FOREIGN KEY ("customer_id", "company_id") REFERENCES "customers"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_document_id_company_id_fkey" FOREIGN KEY ("document_id", "company_id") REFERENCES "documents"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_cash_movement_id_company_id_fkey" FOREIGN KEY ("cash_movement_id", "company_id") REFERENCES "cash_movements"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
