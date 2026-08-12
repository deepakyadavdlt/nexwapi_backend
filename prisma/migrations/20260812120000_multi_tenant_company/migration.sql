-- Multi-tenant Company model + companyId on all tenant tables.
-- Safe/idempotent so live (old User.company string) and local (already db-pushed) both work.

-- ===== Enums =====
DO $$ BEGIN CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'OWNER', 'ADMIN', 'AGENT', 'MEMBER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CompanyStatus" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PlanKey" AS ENUM ('trial', 'starter', 'growth', 'expired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== Company =====
CREATE TABLE IF NOT EXISTS "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "status" "CompanyStatus" NOT NULL DEFAULT 'TRIAL',
    "plan" "PlanKey" NOT NULL DEFAULT 'trial',
    "trialEndsAt" TIMESTAMP(3),
    "trialStartedAt" TIMESTAMP(3),
    "upgradedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "suspendReason" TEXT,
    "lastActiveAt" TIMESTAMP(3),
    "chatbotUsed" BOOLEAN NOT NULL DEFAULT false,
    "walletBalancePaise" INTEGER NOT NULL DEFAULT 0,
    "messageCredits" INTEGER NOT NULL DEFAULT 500,
    "freeAccess" BOOLEAN NOT NULL DEFAULT false,
    "freeAccessNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Company_slug_key" ON "Company"("slug");

-- ===== User: add companyId + modern columns; migrate off User.company string =====
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Convert User.role TEXT -> UserRole enum (live DB still has TEXT)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'role' AND udt_name = 'text'
  ) THEN
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "role_new" "UserRole";
    UPDATE "User" SET "role_new" = CASE
      WHEN role IN ('SUPER_ADMIN', 'SuperAdmin', 'super_admin') THEN 'SUPER_ADMIN'::"UserRole"
      WHEN role IN ('ADMIN', 'Admin') THEN 'ADMIN'::"UserRole"
      WHEN role IN ('AGENT', 'Agent') THEN 'AGENT'::"UserRole"
      WHEN role IN ('MEMBER', 'Member') THEN 'MEMBER'::"UserRole"
      ELSE 'OWNER'::"UserRole"
    END
    WHERE "role_new" IS NULL;
    ALTER TABLE "User" DROP COLUMN "role";
    ALTER TABLE "User" RENAME COLUMN "role_new" TO "role";
    ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'OWNER'::"UserRole";
    ALTER TABLE "User" ALTER COLUMN "role" SET NOT NULL;
  END IF;
END $$;

-- Create a Company per existing user that still has the old "company" string column
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'company'
  ) THEN
    INSERT INTO "Company" (
      "id", "name", "slug", "email", "status", "plan",
      "trialEndsAt", "upgradedAt", "chatbotUsed", "lastActiveAt",
      "createdAt", "updatedAt"
    )
    SELECT
      'co_' || u.id,
      COALESCE(NULLIF(u.company, ''), u.name, 'Workspace'),
      'ws-' || u.id,
      u.email,
      'TRIAL'::"CompanyStatus",
      CASE
        WHEN u.plan IN ('starter', 'growth', 'expired', 'trial') THEN u.plan::"PlanKey"
        ELSE 'trial'::"PlanKey"
      END,
      u."trialEndsAt",
      u."upgradedAt",
      COALESCE(u."chatbotUsed", false),
      u."lastActiveAt",
      u."createdAt",
      NOW()
    FROM "User" u
    WHERE u."companyId" IS NULL
    ON CONFLICT ("id") DO NOTHING;

    UPDATE "User" u
    SET "companyId" = 'co_' || u.id
    WHERE u."companyId" IS NULL;

    ALTER TABLE "User" DROP COLUMN IF EXISTS "company";
    ALTER TABLE "User" DROP COLUMN IF EXISTS "plan";
    ALTER TABLE "User" DROP COLUMN IF EXISTS "trialEndsAt";
    ALTER TABLE "User" DROP COLUMN IF EXISTS "upgradedAt";
    ALTER TABLE "User" DROP COLUMN IF EXISTS "chatbotUsed";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "User_companyId_idx" ON "User"("companyId");

-- ===== New tables =====
CREATE TABLE IF NOT EXISTS "Subscription" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "plan" "PlanKey" NOT NULL DEFAULT 'trial',
    "status" TEXT NOT NULL DEFAULT 'active',
    "trialEndsAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "amount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "billingCycle" TEXT NOT NULL DEFAULT 'monthly',
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_companyId_key" ON "Subscription"("companyId");

CREATE TABLE IF NOT EXISTS "Plan" (
    "id" TEXT NOT NULL,
    "key" "PlanKey" NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "inbox" BOOLEAN NOT NULL DEFAULT true,
    "campaign" BOOLEAN NOT NULL DEFAULT true,
    "chatbot" BOOLEAN NOT NULL DEFAULT true,
    "automation" BOOLEAN NOT NULL DEFAULT true,
    "api" BOOLEAN NOT NULL DEFAULT false,
    "unlimitedAgents" BOOLEAN NOT NULL DEFAULT false,
    "agentLimit" INTEGER NOT NULL DEFAULT 3,
    "contactLimit" INTEGER NOT NULL DEFAULT 1000,
    "messageLimit" INTEGER NOT NULL DEFAULT 5000,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Plan_key_key" ON "Plan"("key");

CREATE TABLE IF NOT EXISTS "WhatsAppAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "businessId" TEXT,
    "wabaId" TEXT,
    "phoneNumberId" TEXT,
    "phoneNumber" TEXT,
    "displayPhoneNumber" TEXT,
    "businessName" TEXT,
    "verifiedName" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "qualityRating" TEXT,
    "messagingLimit" TEXT,
    "verificationStatus" TEXT,
    "webhookStatus" TEXT NOT NULL DEFAULT 'pending',
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "isConnected" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "verifyToken" TEXT,
    "appSecret" TEXT,
    "lastWebhookAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "WhatsAppAccount_companyId_idx" ON "WhatsAppAccount"("companyId");
CREATE INDEX IF NOT EXISTS "WhatsAppAccount_phoneNumberId_idx" ON "WhatsAppAccount"("phoneNumberId");

CREATE TABLE IF NOT EXISTS "WalletTransaction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL DEFAULT 0,
    "creditsDelta" INTEGER NOT NULL DEFAULT 0,
    "balanceAfter" INTEGER NOT NULL DEFAULT 0,
    "creditsAfter" INTEGER NOT NULL DEFAULT 0,
    "meta" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "WalletTransaction_companyId_createdAt_idx" ON "WalletTransaction"("companyId", "createdAt");

CREATE TABLE IF NOT EXISTS "PlatformSetting" (
    "id" TEXT NOT NULL,
    "creditsPerRupee" INTEGER NOT NULL DEFAULT 10,
    "creditPerOutbound" INTEGER NOT NULL DEFAULT 1,
    "creditPerInbound" INTEGER NOT NULL DEFAULT 0,
    "trialCredits" INTEGER NOT NULL DEFAULT 500,
    "starterCredits" INTEGER NOT NULL DEFAULT 5000,
    "growthCredits" INTEGER NOT NULL DEFAULT 20000,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "discountPct" INTEGER NOT NULL DEFAULT 0,
    "freeDays" INTEGER NOT NULL DEFAULT 0,
    "planKey" "PlanKey",
    "maxRedemptions" INTEGER,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Coupon_code_key" ON "Coupon"("code");

CREATE TABLE IF NOT EXISTS "CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CouponRedemption_couponId_companyId_key" ON "CouponRedemption"("couponId", "companyId");

CREATE TABLE IF NOT EXISTS "Usage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "messagesSent" INTEGER NOT NULL DEFAULT 0,
    "messagesRecv" INTEGER NOT NULL DEFAULT 0,
    "campaignsCount" INTEGER NOT NULL DEFAULT 0,
    "apiCalls" INTEGER NOT NULL DEFAULT 0,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    CONSTRAINT "Usage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Usage_companyId_month_year_key" ON "Usage"("companyId", "month", "year");

CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "meta" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AuditLog_companyId_idx" ON "AuditLog"("companyId");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

CREATE TABLE IF NOT EXISTS "Ticket" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "userId" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Ticket_status_idx" ON "Ticket"("status");

-- ===== Existing tables: add companyId =====
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "QuickReply" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Flow" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Label" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Drip" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'plan';
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "creditsAdded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "invoiceNo" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "couponCode" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "refundId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Payment" ALTER COLUMN "userId" DROP NOT NULL;

-- Backfill companyId on old rows from first company
DO $$
DECLARE cid TEXT;
BEGIN
  SELECT id INTO cid FROM "Company" ORDER BY "createdAt" ASC LIMIT 1;
  IF cid IS NOT NULL THEN
    UPDATE "Contact" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Message" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Template" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Campaign" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Automation" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "QuickReply" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Agent" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Flow" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Setting" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "ApiKey" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Product" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Segment" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Label" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Drip" SET "companyId" = cid WHERE "companyId" IS NULL;
    UPDATE "Payment" SET "companyId" = cid WHERE "companyId" IS NULL;
  END IF;
END $$;

-- If still no company (empty User table), skip NOT NULL until data exists.
-- For tables that require companyId in Prisma, set NOT NULL only when no nulls remain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Company") THEN
    IF NOT EXISTS (SELECT 1 FROM "Contact" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "Contact" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Message" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "Message" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Template" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "Template" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Campaign" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "Campaign" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Automation" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "Automation" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "Agent" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Flow" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "Flow" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Product" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "Product" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Segment" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "Segment" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Label" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "Label" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Drip" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "Drip" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "ApiKey" WHERE "companyId" IS NULL) THEN
      ALTER TABLE "ApiKey" ALTER COLUMN "companyId" SET NOT NULL;
    END IF;
  END IF;
END $$;

-- Contact phone unique is now per-company
DROP INDEX IF EXISTS "Contact_phone_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Contact_companyId_phone_key" ON "Contact"("companyId", "phone");
CREATE INDEX IF NOT EXISTS "Contact_companyId_idx" ON "Contact"("companyId");
CREATE INDEX IF NOT EXISTS "Message_companyId_idx" ON "Message"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "Template_companyId_name_key" ON "Template"("companyId", "name");
CREATE INDEX IF NOT EXISTS "Template_companyId_idx" ON "Template"("companyId");
CREATE INDEX IF NOT EXISTS "Campaign_companyId_idx" ON "Campaign"("companyId");
CREATE INDEX IF NOT EXISTS "Automation_companyId_idx" ON "Automation"("companyId");
CREATE INDEX IF NOT EXISTS "QuickReply_companyId_idx" ON "QuickReply"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "Agent_companyId_email_key" ON "Agent"("companyId", "email");
CREATE INDEX IF NOT EXISTS "Agent_companyId_idx" ON "Agent"("companyId");
CREATE INDEX IF NOT EXISTS "Flow_companyId_idx" ON "Flow"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "Setting_companyId_key" ON "Setting"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_companyId_key_key" ON "ApiKey"("companyId", "key");
CREATE INDEX IF NOT EXISTS "ApiKey_companyId_idx" ON "ApiKey"("companyId");
CREATE INDEX IF NOT EXISTS "Product_companyId_idx" ON "Product"("companyId");
CREATE INDEX IF NOT EXISTS "Segment_companyId_idx" ON "Segment"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "Label_companyId_name_key" ON "Label"("companyId", "name");
CREATE INDEX IF NOT EXISTS "Label_companyId_idx" ON "Label"("companyId");
CREATE INDEX IF NOT EXISTS "Drip_companyId_idx" ON "Drip"("companyId");
CREATE INDEX IF NOT EXISTS "Payment_companyId_idx" ON "Payment"("companyId");
CREATE INDEX IF NOT EXISTS "Payment_status_idx" ON "Payment"("status");
CREATE INDEX IF NOT EXISTS "Payment_type_idx" ON "Payment"("type");

-- Foreign keys (ignore if already exist)
DO $$ BEGIN ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Usage" ADD CONSTRAINT "Usage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Message" ADD CONSTRAINT "Message_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Template" ADD CONSTRAINT "Template_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Automation" ADD CONSTRAINT "Automation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Agent" ADD CONSTRAINT "Agent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Flow" ADD CONSTRAINT "Flow_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Setting" ADD CONSTRAINT "Setting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Product" ADD CONSTRAINT "Product_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Segment" ADD CONSTRAINT "Segment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Label" ADD CONSTRAINT "Label_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Drip" ADD CONSTRAINT "Drip_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Payment" ADD CONSTRAINT "Payment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
