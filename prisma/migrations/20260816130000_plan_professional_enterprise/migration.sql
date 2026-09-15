-- Add Professional and Enterprise plan keys
DO $$ BEGIN ALTER TYPE "PlanKey" ADD VALUE 'professional'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "PlanKey" ADD VALUE 'enterprise'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Setting" ALTER COLUMN "autoAssign" SET DEFAULT true;
UPDATE "Setting" SET "autoAssign" = true;
