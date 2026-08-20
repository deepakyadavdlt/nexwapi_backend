import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "./prisma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "../..");

/** Idempotent patches so Prisma queries never hit missing columns/tables. */
async function applyCriticalPatches() {
  await prisma.$executeRawUnsafe(`
    -- Message
    ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "senderName" TEXT;
    ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "senderUserId" TEXT;
    ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "automationSource" TEXT;

    -- Setting (inbox automations, routing, AI)
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "assignmentMode" TEXT NOT NULL DEFAULT 'load_balance';
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "assignOnlineOnly" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "roundRobinIndex" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "welcomeEnabled" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "welcomeMessage" TEXT NOT NULL DEFAULT 'Hi! Thanks for reaching out. How can we help you today?';
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "delayedEnabled" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "delayedMinutes" INTEGER NOT NULL DEFAULT 15;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "delayedMessage" TEXT NOT NULL DEFAULT 'Thanks for your patience! A team member will reply shortly.';
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "customRepliesEnabled" BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "workingHoursSlots" JSONB;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "intentMatchingEnabled" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "flowFollowUpEnabled" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "flowFollowUpMinutes" INTEGER NOT NULL DEFAULT 30;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "flowFollowUpMessage" TEXT NOT NULL DEFAULT 'Hi! Just checking in — would you like to continue?';
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "flowIdleTimeoutMinutes" INTEGER NOT NULL DEFAULT 60;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "aiAgentEnabled" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "aiAgentWebsiteUrl" TEXT NOT NULL DEFAULT '';
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "aiAgentKnowledge" JSONB;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "aiAgentGreeting" TEXT NOT NULL DEFAULT 'Hi! I''m the Nexwapi assistant. How can I help?';
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "voiceAiEnabled" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "voiceAiPlan" TEXT NOT NULL DEFAULT 'business';
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "voiceAiCredits" INTEGER NOT NULL DEFAULT 100;
    ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

    -- Automation / Flow / Template
    ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
    ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "sentCount" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE "Flow" ADD COLUMN IF NOT EXISTS "sentCount" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "Flow" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "email" TEXT;
    ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "failed" INTEGER NOT NULL DEFAULT 0;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AssignmentRule" (
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
    );
    CREATE INDEX IF NOT EXISTS "AssignmentRule_companyId_idx" ON "AssignmentRule"("companyId");

    CREATE TABLE IF NOT EXISTS "WhatsAppForm" (
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
    );
    CREATE INDEX IF NOT EXISTS "WhatsAppForm_companyId_idx" ON "WhatsAppForm"("companyId");

    CREATE TABLE IF NOT EXISTS "InteractiveList" (
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
    );
    CREATE INDEX IF NOT EXISTS "InteractiveList_companyId_idx" ON "InteractiveList"("companyId");
  `);

  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Template_deletedAt_idx" ON "Template"("deletedAt");`);
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
    console.log("  Database schema patches OK");
  } catch (e) {
    console.error("[db] schema patch failed:", e?.message || e);
    throw e;
  }
  runMigrateDeploy();
}
