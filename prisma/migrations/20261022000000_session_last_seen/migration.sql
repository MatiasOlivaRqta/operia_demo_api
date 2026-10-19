ALTER TABLE "sessions" ADD COLUMN "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now();
UPDATE "sessions" SET "last_seen_at" = "created_at";
