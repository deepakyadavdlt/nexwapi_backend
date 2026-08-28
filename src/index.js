// index.js — Nexwapi backend entry point
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import whatsappRoutes from "./routes/whatsappRoutes.js";
import api from "./routes/api.js";
import superAdmin from "./routes/superAdmin.js";
import partner from "./routes/partner.js";
import { WA_LIVE } from "./config/whatsapp.js";
import { attachUser } from "./lib/auth.js";
import { validateEnv, corsOriginCheck, isProduction } from "./lib/env.js";
import { logEmailConfig } from "./lib/mailer.js";
import { ensureDefaultPlans, ensureDefaultCoupons } from "./lib/tenant.js";
import { ensureDatabaseReady } from "./lib/ensureDb.js";
import fs from "fs";
import path from "path";

const UPLOAD_DIR = path.resolve("uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Keep the server alive if a route's async handler rejects (production safety net).
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err?.message || err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err?.message || err));

validateEnv();

const app = express();

// Behind a proxy (ngrok / Render / Railway / Nginx) — trust X-Forwarded-* headers.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ===== CORS: frontend URLs allowed to call this API =====
app.use(cors({ origin: corsOriginCheck, credentials: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// The webhook needs the RAW body, so it must bypass the global JSON parser.
app.use((req, res, next) => {
  if (req.originalUrl === "/api/whatsapp/webhook") return next();
  if (req.originalUrl === "/api/billing/webhook") return next();
  return express.json()(req, res, next);
});

app.use("/uploads", express.static(UPLOAD_DIR)); // media files (images, docs)

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "nexwapi-backend", mode: WA_LIVE ? "live" : "demo" })
);

app.use("/api/whatsapp", whatsappRoutes); // GET verify + POST receive
app.use("/api/super-admin", attachUser, superAdmin); // platform Super Admin
app.use("/api/partner", attachUser, partner); // agency Partner console
app.use("/api", attachUser, api); // dashboard REST API (attaches req.user if a token is present)

// On boot, ensure Super Admin exists when ADMIN_EMAIL/ADMIN_PASSWORD are set.
async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || password.length < 6) return;
  try {
    const { prisma } = await import("./lib/prisma.js");
    const { hashPassword } = await import("./lib/auth.js");
    const hash = await hashPassword(password);
    const adminData = {
      password: hash,
      name: process.env.ADMIN_NAME || "Super Admin",
      role: "SUPER_ADMIN",
      isActive: true,
      companyId: null,
    };
    await prisma.user.upsert({
      where: { email },
      update: adminData,
      create: { email, ...adminData },
    });
    console.log(`  Super Admin ensured: ${email}`);
    await ensureDefaultPlans();
    await ensureDefaultCoupons();
    const { getPlatformPricing } = await import("./lib/wallet.js");
    await getPlatformPricing();
    console.log("  Platform pricing ensured");
  } catch (e) {
    console.error("[ensureAdmin]", e?.message || e);
  }
}

const PORT = process.env.PORT || 5000;

ensureDatabaseReady()
  .then(() => {
    app.listen(PORT, async () => {
      console.log(`\n  Nexwapi backend up on http://localhost:${PORT}`);
      console.log(`  Environment: ${isProduction() ? "production" : "development"} (NODE_ENV=${process.env.NODE_ENV || "unset"})`);
      console.log(`  WhatsApp mode: ${WA_LIVE ? "LIVE (Meta)" : "DEMO (simulated sends)"}`);
      logEmailConfig();
      await ensureAdmin();
      console.log("");
    });
  })
  .catch((e) => {
    console.error("[startup] database init failed:", e?.message || e);
    process.exit(1);
  });

// Scheduler: every 30s, run due scheduled campaigns and drip-campaign steps.
Promise.all([
  import("./lib/campaignRunner.js"),
  import("./lib/dripRunner.js"),
  import("./lib/lifecycleEmails.js"),
  import("./lib/delayedReplyRunner.js"),
  import("./lib/flowRunner.js"),
]).then(([cr, dr, life, delayed, flow]) => {
  setInterval(() => {
    cr.runDueCampaigns().catch(() => {});
    dr.runDueDrips().catch(() => {});
    delayed.runDelayedReplies().catch(() => {});
    flow.runFlowMaintenance().catch(() => {});
  }, 30 * 1000);
  import("./lib/templateSync.js").then((ts) => {
    const tick = () => ts.runPendingTemplateSyncs().catch(() => {});
    setTimeout(tick, 20 * 1000);
    setInterval(tick, 60 * 1000);
  }).catch(() => {});
  setInterval(() => life.runLifecycleEmails().catch(() => {}), 60 * 60 * 1000);
  setTimeout(() => life.runLifecycleEmails().catch(() => {}), 15 * 1000);
});
