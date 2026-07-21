// lib/env.js — startup env validation
const DEV_JWT_FALLBACK = "nexwapi_dev_secret_change_me";

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

export function getJwtSecret() {
  return process.env.JWT_SECRET || DEV_JWT_FALLBACK;
}

export function validateEnv() {
  const secret = process.env.JWT_SECRET;
  const weak =
    !secret ||
    secret.length < 32 ||
    secret === DEV_JWT_FALLBACK ||
    secret === "change_me" ||
    secret === "secret";

  if (isProduction() && weak) {
    console.error(
      "\n  FATAL: Set JWT_SECRET to a strong random string (32+ chars) in production.\n" +
        "  Example: openssl rand -base64 48\n"
    );
    process.exit(1);
  }

  if (!isProduction() && weak) {
    console.warn("  WARNING: Using default JWT_SECRET — fine for local dev only.");
  }

  if (isProduction() && !process.env.DATABASE_URL) {
    console.error("\n  FATAL: DATABASE_URL is required in production.\n");
    process.exit(1);
  }
}

export function corsAllowedOrigins() {
  const fromEnv = (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return [
    "https://nexwapi.com",
    "https://www.nexwapi.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...fromEnv,
  ];
}

export function corsOriginCheck(origin, cb) {
  if (!origin) return cb(null, true);
  const allowed = corsAllowedOrigins();
  if (allowed.includes(origin)) return cb(null, true);
  if (/^https?:\/\/([a-z0-9-]+\.)*nexwapi\.com(:\d+)?$/i.test(origin)) return cb(null, true);
  return cb(null, false);
}
