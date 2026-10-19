ALTER TABLE "customers"
  DROP CONSTRAINT "customers_cuit_digits_check";

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_document_number_format_check"
  CHECK (
    ("document_type" = 'CUIT' AND "document_number" ~ '^[0-9]{11}$')
    OR ("document_type" = 'DNI' AND "document_number" ~ '^[0-9]{7,8}$')
    OR ("document_type" = 'PASAPORTE' AND "document_number" ~ '^[A-Z0-9]{6,20}$')
  );
