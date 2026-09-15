-- Partner billing columns (Nexwapi credit line on client WABAs)
ALTER TABLE "WhatsAppAccount" ADD COLUMN IF NOT EXISTS "billingCurrency" TEXT;
ALTER TABLE "WhatsAppAccount" ADD COLUMN IF NOT EXISTS "partnerBillingAt" TIMESTAMP(3);
