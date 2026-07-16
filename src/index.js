// index.js — Nexwapi backend entry point
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import whatsappRoutes from "./routes/whatsappRoutes.js";
import api from "./routes/api.js";
import { WA_LIVE } from "./config/whatsapp.js";
import { attachUser } from "./lib/auth.js";
import fs from "fs";
import path from "path";

const UPLOAD_DIR = path.resolve("uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Keep the server alive if a route's async handler rejects (production safety net).
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err?.message || err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err?.message || err));

const app = express();

// Behind a proxy (ngrok / Render / Railway / Nginx) — trust X-Forwarded-* headers.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ===== CORS: frontend URLs allowed to call this API =====
// 👉 Add your frontend URLs here.
const ALLOWED_ORIGINS = [
  "https://nexwapi.com",
  "https://www.nexwapi.com",
  "http://localhost:3000",
  // plus anything set in the CORS_ORIGIN env var (comma-separated)
  ...(process.env.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean),
];
function corsOrigin(origin, cb) {
  if (!origin) return cb(null, true); // curl / server-to-server / same-origin
  if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
  // also allow any *.nexwapi.com subdomain
  if (/^https?:\/\/([a-z0-9-]+\.)*nexwapi\.com(:\d+)?$/i.test(origin)) return cb(null, true);
  return cb(null, false);
}
app.use(cors({ origin: corsOrigin }));
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
app.use("/api", attachUser, api); // dashboard REST API (attaches req.user if a token is present)

// On boot, ensure an admin login exists when ADMIN_EMAIL/ADMIN_PASSWORD are set.
// This lets production create/update the admin just by setting env vars + deploy,
// without running a script against the live database.
async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || password.length < 6) return;
  try {
    const { prisma } = await import("./lib/prisma.js");
    const { hashPassword } = await import("./lib/auth.js");
    const hash = await hashPassword(password);
    await prisma.user.upsert({
      where: { email },
      update: { password: hash, role: "Owner", plan: "pro" },
      create: { email, password: hash, name: process.env.ADMIN_NAME || "Admin", company: "Nexwapi", role: "Owner", plan: "pro" },
    });
    console.log(`  Admin ensured: ${email}`);
  } catch (e) {
    console.error("[ensureAdmin]", e?.message || e);
  }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`\n  Nexwapi backend up on http://localhost:${PORT}`);
  console.log(`  WhatsApp mode: ${WA_LIVE ? "LIVE (Meta)" : "DEMO (simulated sends)"}`);
  await ensureAdmin();
  console.log("");
});

// Scheduler: every 30s, run due scheduled campaigns and drip-campaign steps.
Promise.all([import("./lib/campaignRunner.js"), import("./lib/dripRunner.js")]).then(([cr, dr]) => {
  setInterval(() => {
    cr.runDueCampaigns().catch(() => {});
    dr.runDueDrips().catch(() => {});
  }, 30 * 1000);
});
