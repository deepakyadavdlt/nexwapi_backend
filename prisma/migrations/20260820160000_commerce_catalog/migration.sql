-- WhatsApp Commerce / Meta Catalog

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "retailerId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "availability" TEXT NOT NULL DEFAULT 'in stock';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "collectionMetaId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "metaProductId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "Product_companyId_retailerId_idx" ON "Product"("companyId", "retailerId");

CREATE TABLE IF NOT EXISTS "CommerceSetting" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL DEFAULT '',
    "catalogName" TEXT NOT NULL DEFAULT '',
    "connectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "sandboxMode" BOOLEAN NOT NULL DEFAULT true,
    "partnerAccessGranted" BOOLEAN NOT NULL DEFAULT false,
    "collectionsBody" TEXT NOT NULL DEFAULT 'Hey there, check out our top product collections',
    "collectionsButton" TEXT NOT NULL DEFAULT 'View Collections',
    "catalogInCampaigns" BOOLEAN NOT NULL DEFAULT false,
    "catalogInAutoReplies" BOOLEAN NOT NULL DEFAULT false,
    "autocheckoutEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autocheckoutFlowId" TEXT NOT NULL DEFAULT '',
    "paymentLinkBase" TEXT NOT NULL DEFAULT '',
    "shippingPrompt" TEXT NOT NULL DEFAULT 'Thanks for your cart! Please share your full shipping address (name, street, city, pincode, phone).',
    "paymentPrompt" TEXT NOT NULL DEFAULT 'Great — here is your payment link. Once paid, we will confirm your order.',
    "orderConfirmMessage" TEXT NOT NULL DEFAULT 'Your order is confirmed! We will update you when it ships.',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommerceSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommerceSetting_companyId_key" ON "CommerceSetting"("companyId");

CREATE TABLE IF NOT EXISTS "CatalogCollection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "metaSetId" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "includeInTop10" BOOLEAN NOT NULL DEFAULT true,
    "headerText" TEXT NOT NULL DEFAULT '',
    "bodyText" TEXT NOT NULL DEFAULT '',
    "footerText" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "productRetailerIds" JSONB NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CatalogCollection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CatalogCollection_companyId_idx" ON "CatalogCollection"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "CatalogCollection_companyId_metaSetId_key" ON "CatalogCollection"("companyId", "metaSetId");

CREATE TABLE IF NOT EXISTS "CommerceOrder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "contactPhone" TEXT NOT NULL DEFAULT '',
    "contactName" TEXT NOT NULL DEFAULT '',
    "waMessageId" TEXT,
    "catalogId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'enquiry',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "totalAmount" TEXT NOT NULL DEFAULT '0',
    "items" JSONB NOT NULL DEFAULT '[]',
    "shippingAddress" JSONB,
    "paymentLink" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'whatsapp_cart',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommerceOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CommerceOrder_companyId_createdAt_idx" ON "CommerceOrder"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "CommerceOrder_companyId_status_idx" ON "CommerceOrder"("companyId", "status");
CREATE INDEX IF NOT EXISTS "CommerceOrder_contactId_idx" ON "CommerceOrder"("contactId");
