-- Razorpay-style API credentials
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "keyId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_keyId_key" ON "ApiKey"("keyId");
ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "webhookSecret" TEXT NOT NULL DEFAULT '';
