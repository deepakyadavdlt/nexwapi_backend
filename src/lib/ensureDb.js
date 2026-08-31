import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "./prisma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "../..");

/**
 * Run each statement separately.
 * Prisma/pg often only executes the FIRST statement in a multi-statement string,
 * which is why Campaign.category etc. never got created on production.
 */
async function runSql(statements) {
  let ok = 0;
  let failed = 0;
  for (const sql of statements) {
    const trimmed = String(sql || "").trim();
    if (!trimmed || trimmed.startsWith("--")) continue;
    try {
      await prisma.$executeRawUnsafe(trimmed);
      ok += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[db] patch skip: ${trimmed.slice(0, 80)}… → ${e?.message || e}`);
    }
  }
  return { ok, failed };
}

/** Idempotent patches so Prisma queries never hit missing columns/tables. */
async function applyCriticalPatches() {
  const columnPatches = [
    // Message
    `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "senderName" TEXT`,
    `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "senderUserId" TEXT`,
    `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "automationSource" TEXT`,

    // Setting
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "assignmentMode" TEXT NOT NULL DEFAULT 'load_balance'`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "assignOnlineOnly" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "roundRobinIndex" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "welcomeEnabled" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "welcomeMessage" TEXT NOT NULL DEFAULT 'Hi! Thanks for reaching out. How can we help you today?'`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "delayedEnabled" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "delayedMinutes" INTEGER NOT NULL DEFAULT 15`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "delayedMessage" TEXT NOT NULL DEFAULT 'Thanks for your patience! A team member will reply shortly.'`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "customRepliesEnabled" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "workingHoursSlots" JSONB`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "intentMatchingEnabled" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "flowFollowUpEnabled" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "flowFollowUpMinutes" INTEGER NOT NULL DEFAULT 30`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "flowFollowUpMessage" TEXT NOT NULL DEFAULT 'Hi! Just checking in — would you like to continue?'`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "flowIdleTimeoutMinutes" INTEGER NOT NULL DEFAULT 60`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "aiAgentEnabled" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "aiAgentWebsiteUrl" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "aiAgentKnowledge" JSONB`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "aiAgentGreeting" TEXT NOT NULL DEFAULT 'Hi! I''m the Nexwapi assistant. How can I help?'`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "voiceAiEnabled" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "voiceAiPlan" TEXT NOT NULL DEFAULT 'business'`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "voiceAiCredits" INTEGER NOT NULL DEFAULT 100`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,

    // Automation / Flow / Template
    `ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "companyId" TEXT`,
    `ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "sentCount" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE "Flow" ADD COLUMN IF NOT EXISTS "sentCount" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "Flow" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3)`,
    `ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "headerFormat" TEXT`,
    `ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "headerImageUrl" TEXT`,

    // Contact
    `ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "email" TEXT`,
    `ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "userId" TEXT`,
    `ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "optedIn" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "attributes" JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "assignedAgentId" TEXT`,
    `ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "activeFlowId" TEXT`,
    `ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "activeFlowStep" TEXT`,
    `ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "chatStatus" TEXT NOT NULL DEFAULT 'open'`,
    `ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "labels" TEXT[] DEFAULT ARRAY[]::TEXT[]`,
    `ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "companyId" TEXT`,

    // Campaign — these were never applied before because of multi-statement bug
    `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "failed" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "campaignType" TEXT NOT NULL DEFAULT 'onetime'`,
    `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "category" TEXT`,
    `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP(3)`,
    `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "liveAt" TIMESTAMP(3)`,
    `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "companyId" TEXT`,

    // Segment
    `ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "filters" JSONB`,
    `ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "whatsappOnly" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,

    // Product commerce fields
    `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "retailerId" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'INR'`,
    `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "availability" TEXT NOT NULL DEFAULT 'in stock'`,
    `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'local'`,
    `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "collectionMetaId" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "metaProductId" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "availability" TEXT NOT NULL DEFAULT 'online'`,
    `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "firstName" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "lastName" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "phone" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'inbox'`,
    `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "inviteStatus" TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "createdBy" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "teamId" TEXT`,

    // Autocheckout workflow fields
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "shippingMode" TEXT NOT NULL DEFAULT 'free'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "shippingAmount" TEXT NOT NULL DEFAULT '0'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "freeShippingAbove" TEXT NOT NULL DEFAULT '2000'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "discountEnabled" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "discountType" TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "discountValue" TEXT NOT NULL DEFAULT '0'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT NOT NULL DEFAULT 'cod'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "proceedMessage" TEXT NOT NULL DEFAULT 'Thanks for your cart! {{shipping_note}} Your total order value is {{total_order_value}}. Would you like to go ahead with the order?'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "askNameMessage" TEXT NOT NULL DEFAULT 'Great! We will require some details to ship the order. Please provide your full name.'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "askPincodeMessage" TEXT NOT NULL DEFAULT 'Please provide the Pincode/Postcode/Zipcode of the delivery location.'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "askAddressMessage" TEXT NOT NULL DEFAULT 'Please enter your street address, building name/number, flat number, floor etc. For example: 123, MG Road, Kusum Apartments, Flat no. 123, 1st floor.'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "confirmOrderMessage" TEXT NOT NULL DEFAULT 'Thanks for providing the details! We have noted your address as: {{address}}. {{payment_note}} Would you like to confirm the order?'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "cancelMessage" TEXT NOT NULL DEFAULT 'No problem! Your cart is saved. Message us anytime when you are ready to order.'`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "shippingConfirmed" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "discountsConfirmed" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "paymentConfirmed" BOOLEAN NOT NULL DEFAULT false`,

    // Order Panel statuses
    `ALTER TABLE "CommerceOrder" ADD COLUMN IF NOT EXISTS "orderStatus" TEXT NOT NULL DEFAULT 'cart_received'`,
    `ALTER TABLE "CommerceOrder" ADD COLUMN IF NOT EXISTS "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid'`,
    `ALTER TABLE "CommerceOrder" ADD COLUMN IF NOT EXISTS "fulfillmentStatus" TEXT NOT NULL DEFAULT 'not_scheduled'`,

    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "webhookUrl" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "rejectOptedOutApi" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "teamShowMembersInAssignee" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "teamLeadCanAssignContacts" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "teamLeadCanViewTeamContacts" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "maxCustomTags" INTEGER NOT NULL DEFAULT 15`,
    `ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "maxCustomEvents" INTEGER NOT NULL DEFAULT 2`,
    `ALTER TABLE "QuickReply" ADD COLUMN IF NOT EXISTS "createdBy" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "QuickReply" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'en'`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "partnerId" TEXT`,
    `ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "partnerId" TEXT`,
    `ALTER TABLE "Partner" ADD COLUMN IF NOT EXISTS "plan" TEXT NOT NULL DEFAULT 'agency'`,
    `ALTER TABLE "Partner" ADD COLUMN IF NOT EXISTS "websiteUrl" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Team" ADD COLUMN IF NOT EXISTS "leadIds" TEXT[] DEFAULT ARRAY[]::TEXT[]`,
    `ALTER TABLE "Team" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  ];

  const tablePatches = [
    `DO $$ BEGIN CREATE TYPE "PartnerStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'UserRole' AND e.enumlabel = 'PARTNER') THEN ALTER TYPE "UserRole" ADD VALUE 'PARTNER'; END IF; END $$`,
    `CREATE TABLE IF NOT EXISTS "Partner" (
      "id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "slug" TEXT NOT NULL,
      "email" TEXT,
      "phone" TEXT,
      "status" "PartnerStatus" NOT NULL DEFAULT 'PENDING',
      "plan" TEXT NOT NULL DEFAULT 'agency',
      "maxClients" INTEGER NOT NULL DEFAULT 50,
      "paidAt" TIMESTAMP(3),
      "paymentNote" TEXT,
      "paymentAmount" INTEGER NOT NULL DEFAULT 0,
      "productName" TEXT NOT NULL DEFAULT '',
      "logoUrl" TEXT,
      "primaryColor" TEXT NOT NULL DEFAULT '#0f8a3c',
      "customDomain" TEXT,
      "websiteUrl" TEXT NOT NULL DEFAULT '',
      "notes" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Partner_slug_key" ON "Partner"("slug")`,
    `CREATE INDEX IF NOT EXISTS "Partner_status_idx" ON "Partner"("status")`,
    `CREATE INDEX IF NOT EXISTS "Partner_customDomain_idx" ON "Partner"("customDomain")`,
    `CREATE INDEX IF NOT EXISTS "Company_partnerId_idx" ON "Company"("partnerId")`,
    `CREATE INDEX IF NOT EXISTS "User_partnerId_idx" ON "User"("partnerId")`,
    `CREATE TABLE IF NOT EXISTS "AssignmentRule" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "trait" TEXT NOT NULL,
      "condition" TEXT NOT NULL DEFAULT 'contains',
      "values" TEXT[] DEFAULT ARRAY[]::TEXT[],
      "agentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "priority" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AssignmentRule_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "AssignmentRule_companyId_idx" ON "AssignmentRule"("companyId")`,
    `CREATE TABLE IF NOT EXISTS "WhatsAppForm" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "triggerKeyword" TEXT NOT NULL DEFAULT '',
      "fields" JSONB NOT NULL DEFAULT '[]',
      "thankYouMessage" TEXT NOT NULL DEFAULT 'Thanks! We received your details.',
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "submissionCount" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "WhatsAppForm_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "WhatsAppForm_companyId_idx" ON "WhatsAppForm"("companyId")`,
    `CREATE TABLE IF NOT EXISTS "InteractiveList" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "header" TEXT NOT NULL DEFAULT '',
      "body" TEXT NOT NULL DEFAULT '',
      "footer" TEXT NOT NULL DEFAULT '',
      "buttonText" TEXT NOT NULL DEFAULT 'View options',
      "sections" JSONB NOT NULL DEFAULT '[]',
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "sentCount" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "InteractiveList_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "InteractiveList_companyId_idx" ON "InteractiveList"("companyId")`,
    `CREATE INDEX IF NOT EXISTS "Template_deletedAt_idx" ON "Template"("deletedAt")`,
    `CREATE INDEX IF NOT EXISTS "Campaign_status_idx" ON "Campaign"("status")`,

    // Notification (never migrated on some production DBs)
    `CREATE TABLE IF NOT EXISTS "Notification" (
      "id" TEXT NOT NULL,
      "audience" TEXT NOT NULL DEFAULT 'client',
      "companyId" TEXT,
      "userId" TEXT,
      "title" TEXT NOT NULL,
      "body" TEXT NOT NULL DEFAULT '',
      "href" TEXT NOT NULL DEFAULT '',
      "read" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "Notification_audience_createdAt_idx" ON "Notification"("audience", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "Notification_companyId_createdAt_idx" ON "Notification"("companyId", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "Notification_userId_read_idx" ON "Notification"("userId", "read")`,

    // Sales leads
    `CREATE TABLE IF NOT EXISTS "SalesLead" (
      "id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "email" TEXT NOT NULL,
      "phone" TEXT NOT NULL DEFAULT '',
      "company" TEXT NOT NULL DEFAULT '',
      "message" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'new',
      "note" TEXT NOT NULL DEFAULT '',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SalesLead_pkey" PRIMARY KEY ("id")
    )`,

    `CREATE TABLE IF NOT EXISTS "Team" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Team_companyId_name_key" ON "Team"("companyId", "name")`,
    `CREATE INDEX IF NOT EXISTS "Team_companyId_idx" ON "Team"("companyId")`,

    `CREATE TABLE IF NOT EXISTS "RolePermission" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "role" TEXT NOT NULL,
      "permissions" JSONB NOT NULL DEFAULT '{}',
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "RolePermission_companyId_role_key" ON "RolePermission"("companyId", "role")`,
    `CREATE INDEX IF NOT EXISTS "RolePermission_companyId_idx" ON "RolePermission"("companyId")`,

    `CREATE TABLE IF NOT EXISTS "Tag" (
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
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Tag_companyId_name_key" ON "Tag"("companyId", "name")`,
    `CREATE INDEX IF NOT EXISTS "Tag_companyId_idx" ON "Tag"("companyId")`,
    `CREATE INDEX IF NOT EXISTS "Tag_companyId_deletedAt_idx" ON "Tag"("companyId", "deletedAt")`,

    `CREATE TABLE IF NOT EXISTS "CustomEvent" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "traits" TEXT[] DEFAULT ARRAY[]::TEXT[],
      "description" TEXT NOT NULL DEFAULT '',
      "createdBy" TEXT NOT NULL DEFAULT '',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CustomEvent_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "CustomEvent_companyId_name_key" ON "CustomEvent"("companyId", "name")`,
    `CREATE INDEX IF NOT EXISTS "CustomEvent_companyId_idx" ON "CustomEvent"("companyId")`,

    `CREATE TABLE IF NOT EXISTS "CommerceSetting" (
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
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "CommerceSetting_companyId_key" ON "CommerceSetting"("companyId")`,

    `CREATE TABLE IF NOT EXISTS "CatalogCollection" (
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
    )`,
    `CREATE INDEX IF NOT EXISTS "CatalogCollection_companyId_idx" ON "CatalogCollection"("companyId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "CatalogCollection_companyId_metaSetId_key" ON "CatalogCollection"("companyId", "metaSetId")`,

    `CREATE TABLE IF NOT EXISTS "CommerceOrder" (
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
    )`,
    `CREATE INDEX IF NOT EXISTS "CommerceOrder_companyId_createdAt_idx" ON "CommerceOrder"("companyId", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "CommerceOrder_companyId_status_idx" ON "CommerceOrder"("companyId", "status")`,
    `CREATE INDEX IF NOT EXISTS "CommerceOrder_companyId_orderStatus_idx" ON "CommerceOrder"("companyId", "orderStatus")`,
    `CREATE INDEX IF NOT EXISTS "CommerceOrder_companyId_paymentStatus_idx" ON "CommerceOrder"("companyId", "paymentStatus")`,
    `CREATE INDEX IF NOT EXISTS "CommerceOrder_companyId_fulfillmentStatus_idx" ON "CommerceOrder"("companyId", "fulfillmentStatus")`,

    `CREATE TABLE IF NOT EXISTS "Integration" (
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
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Integration_companyId_provider_key" ON "Integration"("companyId", "provider")`,
    `CREATE INDEX IF NOT EXISTS "Integration_companyId_idx" ON "Integration"("companyId")`,
  ];

  const r1 = await runSql(columnPatches);
  const r2 = await runSql(tablePatches);
  console.log(`  Database schema patches OK (${r1.ok + r2.ok} applied, ${r1.failed + r2.failed} skipped)`);

  // Hard-verify the columns that keep breaking production
  try {
    await prisma.$queryRawUnsafe(`SELECT "category", "campaignType", "failed", "liveAt" FROM "Campaign" LIMIT 0`);
    console.log("  Campaign columns verified (category, campaignType, failed, liveAt)");
  } catch (e) {
    console.error("  Campaign columns STILL missing after patch:", e?.message || e);
    throw e;
  }
  try {
    await prisma.$queryRawUnsafe(`SELECT 1 FROM "Notification" LIMIT 0`);
    console.log("  Notification table verified");
  } catch (e) {
    console.error("  Notification table STILL missing after patch:", e?.message || e);
    throw e;
  }
  try {
    await prisma.$queryRawUnsafe(`SELECT "email", "userId", "attributes" FROM "Contact" LIMIT 0`);
    console.log("  Contact columns verified (email, userId, attributes)");
  } catch (e) {
    console.error("  Contact columns STILL missing after patch:", e?.message || e);
    throw e;
  }
  try {
    await prisma.$queryRawUnsafe(`SELECT "headerFormat", "headerImageUrl" FROM "Template" LIMIT 0`);
    console.log("  Template header columns verified (headerFormat, headerImageUrl)");
  } catch (e) {
    console.error("  Template header columns STILL missing after patch:", e?.message || e);
    throw e;
  }
}

function runPrismaGenerate() {
  try {
    execSync("npx prisma generate", {
      cwd: backendRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    console.log("  Prisma client regenerated");
    return true;
  } catch (e) {
    const err = e.stderr?.toString()?.trim() || e.stdout?.toString()?.trim() || e.message;
    console.warn("[db] prisma generate:", err.split("\n")[0]);
    return false;
  }
}

function runMigrateDeploy() {
  try {
    const out = execSync("npx prisma migrate deploy", {
      cwd: backendRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const line = out.trim().split("\n").filter(Boolean).pop();
    if (line) console.log(`  ${line}`);
    return true;
  } catch (e) {
    const err = e.stderr?.toString()?.trim() || e.stdout?.toString()?.trim() || e.message;
    console.warn("[db] migrate deploy:", err.split("\n")[0]);
    return false;
  }
}

export async function ensureDatabaseReady() {
  try {
    await applyCriticalPatches();
  } catch (e) {
    console.error("[db] schema patch failed:", e?.message || e);
    throw e;
  }
  runMigrateDeploy();
  runPrismaGenerate();
}
