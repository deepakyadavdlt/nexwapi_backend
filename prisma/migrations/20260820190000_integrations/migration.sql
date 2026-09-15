-- Integrations connections
CREATE TABLE IF NOT EXISTS "Integration" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "config" JSONB NOT NULL DEFAULT '{}',
    "webhookSecret" TEXT NOT NULL DEFAULT '',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Integration_companyId_provider_key" ON "Integration"("companyId", "provider");
CREATE INDEX IF NOT EXISTS "Integration_companyId_idx" ON "Integration"("companyId");
CREATE INDEX IF NOT EXISTS "Integration_provider_status_idx" ON "Integration"("provider", "status");
