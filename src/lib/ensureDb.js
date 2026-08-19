import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "./prisma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "../..");

/** Idempotent patches for columns that must exist before Prisma queries run. */
async function applyCriticalPatches() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "senderName" TEXT;
    ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "senderUserId" TEXT;
  `);
}

/** Run prisma migrate deploy so production stays in sync even when PM2 skips npm start. */
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
