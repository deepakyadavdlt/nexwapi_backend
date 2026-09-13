-- Enterprise seat packs + Talk-to-Sales assign fields
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "purchasedSeats" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "seats" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SalesLead" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "SalesLead" ADD COLUMN IF NOT EXISTS "assignedUserId" TEXT;
ALTER TABLE "SalesLead" ADD COLUMN IF NOT EXISTS "assignedAgentEmail" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SalesLead" ADD COLUMN IF NOT EXISTS "assignedAt" TIMESTAMP(3);
ALTER TABLE "SalesLead" ADD COLUMN IF NOT EXISTS "requestedSeats" INTEGER NOT NULL DEFAULT 13;

CREATE INDEX IF NOT EXISTS "SalesLead_companyId_idx" ON "SalesLead"("companyId");
CREATE INDEX IF NOT EXISTS "SalesLead_assignedUserId_idx" ON "SalesLead"("assignedUserId");
CREATE INDEX IF NOT EXISTS "SalesLead_status_createdAt_idx" ON "SalesLead"("status", "createdAt");
