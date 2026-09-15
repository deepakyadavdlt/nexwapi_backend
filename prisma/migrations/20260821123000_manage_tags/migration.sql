-- Manage Tags (audience tags)
CREATE TABLE IF NOT EXISTS "Tag" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#25D366',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdBy" TEXT NOT NULL DEFAULT '',
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Tag_companyId_name_key" ON "Tag"("companyId", "name");
CREATE INDEX IF NOT EXISTS "Tag_companyId_idx" ON "Tag"("companyId");
CREATE INDEX IF NOT EXISTS "Tag_companyId_deletedAt_idx" ON "Tag"("companyId", "deletedAt");

DO $$ BEGIN
  ALTER TABLE "Tag" ADD CONSTRAINT "Tag_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "maxCustomTags" INTEGER NOT NULL DEFAULT 15;
