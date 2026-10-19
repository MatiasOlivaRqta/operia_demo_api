CREATE TYPE "person_type" AS ENUM ('FISICA', 'JURIDICA');
CREATE TYPE "document_type" AS ENUM ('DNI', 'CUIT', 'PASAPORTE');

ALTER TABLE "customers"
  ADD COLUMN "person_type" "person_type" NOT NULL DEFAULT 'JURIDICA',
  ADD COLUMN "document_type" "document_type" NOT NULL DEFAULT 'CUIT';

ALTER TABLE "customers" RENAME COLUMN "cuit" TO "document_number";
ALTER TABLE "customers" ALTER COLUMN "document_number" TYPE VARCHAR(20);

DROP INDEX "customers_company_id_cuit_key";
CREATE UNIQUE INDEX "customers_company_id_document_type_document_number_key"
  ON "customers"("company_id", "document_type", "document_number");
