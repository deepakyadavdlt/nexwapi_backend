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

app.use(
  cors({
    origin: ["http://localhost:3000", "https://nexwapi.com"],
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// The webhook needs the RAW body, so it must bypass the global JSON parser.
app.use((req, res, next) => {
  if (req.originalUrl === "/api/whatsapp/webhook") return next();
  return express.json()(req, res, next);
});

app.use("/uploads", express.static(UPLOAD_DIR)); // media files (images, docs)

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "nexwapi-backend", mode: WA_LIVE ? "live" : "demo" })
);

app.use("/api/whatsapp", whatsappRoutes); // GET verify + POST receive
app.use("/api", attachUser, api); // dashboard REST API (attaches req.user if a token is present)

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n  Nexwapi backend up on http://localhost:${PORT}`);
  console.log(`  WhatsApp mode: ${WA_LIVE ? "LIVE (Meta)" : "DEMO (simulated sends)"}\n`);
});

// Scheduler: every 30s, run due scheduled campaigns and drip-campaign steps.
Promise.all([import("./lib/campaignRunner.js"), import("./lib/dripRunner.js")]).then(([cr, dr]) => {
  setInterval(() => {
    cr.runDueCampaigns().catch(() => {});
    dr.runDueDrips().catch(() => {});
  }, 30 * 1000);
});
