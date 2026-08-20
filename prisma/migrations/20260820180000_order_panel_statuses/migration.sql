-- Order Panel Interakt-style status fields
ALTER TABLE "CommerceOrder" ADD COLUMN IF NOT EXISTS "orderStatus" TEXT NOT NULL DEFAULT 'cart_received';
ALTER TABLE "CommerceOrder" ADD COLUMN IF NOT EXISTS "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE "CommerceOrder" ADD COLUMN IF NOT EXISTS "fulfillmentStatus" TEXT NOT NULL DEFAULT 'not_scheduled';
CREATE INDEX IF NOT EXISTS "CommerceOrder_companyId_orderStatus_idx" ON "CommerceOrder"("companyId", "orderStatus");
CREATE INDEX IF NOT EXISTS "CommerceOrder_companyId_paymentStatus_idx" ON "CommerceOrder"("companyId", "paymentStatus");
CREATE INDEX IF NOT EXISTS "CommerceOrder_companyId_fulfillmentStatus_idx" ON "CommerceOrder"("companyId", "fulfillmentStatus");
