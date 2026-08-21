-- Custom events (Events Settings)
CREATE TABLE IF NOT EXISTS "CustomEvent" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "traits" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "description" TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomEvent_companyId_name_key" ON "CustomEvent"("companyId", "name");
CREATE INDEX IF NOT EXISTS "CustomEvent_companyId_idx" ON "CustomEvent"("companyId");

DO $$ BEGIN
  ALTER TABLE "CustomEvent" ADD CONSTRAINT "CustomEvent_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "maxCustomEvents" INTEGER NOT NULL DEFAULT 2;
