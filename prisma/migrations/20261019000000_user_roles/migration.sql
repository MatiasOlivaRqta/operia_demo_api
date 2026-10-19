CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[] NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "roles_company_id_name_key" ON "roles"("company_id", "name");
CREATE UNIQUE INDEX "roles_id_company_id_key" ON "roles"("id", "company_id");
CREATE INDEX "roles_company_id_idx" ON "roles"("company_id");

ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memberships" ADD COLUMN "role_id" UUID;

INSERT INTO "roles" ("id", "company_id", "name", "permissions", "is_system")
SELECT gen_random_uuid(), "id", 'ADMIN', ARRAY[]::TEXT[], true
FROM "companies";

UPDATE "memberships" AS membership
SET "role_id" = role."id"
FROM "roles" AS role
WHERE role."company_id" = membership."company_id"
  AND role."name" = 'ADMIN';

ALTER TABLE "memberships" ALTER COLUMN "role_id" SET NOT NULL;

ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_company_id_fkey"
  FOREIGN KEY ("role_id", "company_id") REFERENCES "roles"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "memberships_role_id_idx" ON "memberships"("role_id");
