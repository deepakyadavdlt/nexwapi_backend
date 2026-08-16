import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getJwtSecret } from "./env.js";
import { sendOtpEmail } from "./mailer.js";

const FILE = path.resolve("data/otps.json");

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeAll(rows) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(rows, null, 2));
}

function hashCode(email, purpose, code) {
  return crypto.createHmac("sha256", getJwtSecret()).update(`${email}:${purpose}:${code}`).digest("hex");
}

export function randomOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

export async function issueOtp(email, purpose, payload = {}) {
  const em = String(email || "").toLowerCase().trim();
  if (!em) throw new Error("email required");
  const code = randomOtp();
  const rows = readAll().filter((r) => !(r.email === em && r.purpose === purpose) && Date.now() < r.expiresAt);
  rows.push({
    email: em,
    purpose,
    hash: hashCode(em, purpose, code),
    payload,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  writeAll(rows);
  await sendOtpEmail(em, code, purpose);
  return { ok: true, expiresIn: 600 };
}

export function verifyOtp(email, purpose, code) {
  const em = String(email || "").toLowerCase().trim();
  const c = String(code || "").trim();
  const rows = readAll();
  const i = rows.findIndex((r) => r.email === em && r.purpose === purpose && Date.now() < r.expiresAt);
  if (i < 0) return { ok: false, error: "OTP expired or not found" };
  if (rows[i].hash !== hashCode(em, purpose, c)) return { ok: false, error: "Invalid OTP" };
  const payload = rows[i].payload || {};
  rows.splice(i, 1);
  writeAll(rows);
  return { ok: true, payload };
}

export async function requireOtpOrSkip(email, purpose, code) {
  const { mailConfigured } = await import("./mailer.js");
  if (!mailConfigured()) return { ok: true, skipped: true };
  if (!code) {
    await issueOtp(email, purpose);
    return { ok: false, otpRequired: true };
  }
  return verifyOtp(email, purpose, code);
}
