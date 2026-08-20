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
  ];

  const tablePatches = [
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
}
