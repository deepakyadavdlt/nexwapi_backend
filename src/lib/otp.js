import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getJwtSecret, isProduction } from "./env.js";
import { emailDeliveryConfigured, sendOtpEmail } from "./mailer.js";

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

function devOtpConsoleAllowed() {
  if (isProduction()) {
    return String(process.env.OTP_DEV_CONSOLE || "").toLowerCase() === "true";
  }
  return String(process.env.OTP_DEV_CONSOLE || "").toLowerCase() !== "false";
}

export async function issueOtp(email, purpose, payload = {}) {
  const em = String(email || "").toLowerCase().trim();
  if (!em) throw new Error("email required");
  const code = randomOtp();
  const rows = readAll().filter((r) => !(r.email === em && r.purpose === purpose) && Date.now() < r.expiresAt);
  const entry = {
    email: em,
    purpose,
    hash: hashCode(em, purpose, code),
    payload,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  rows.push(entry);
  writeAll(rows);

  let emailSent = false;
  let devConsole = false;

  try {
    await sendOtpEmail(em, code, purpose);
    emailSent = true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (!emailDeliveryConfigured() && !isProduction()) {
      console.warn(`[otp] No email configured — ${purpose} OTP for ${em}: ${code}`);
      devConsole = true;
    } else if (devOtpConsoleAllowed()) {
      console.warn(`[otp:dev] ${purpose} OTP for ${em}: ${code} (email failed: ${msg})`);
      devConsole = true;
    } else {
      writeAll(rows.filter((r) => r !== entry));
      throw e;
    }
  }

  return {
    ok: true,
    expiresIn: 600,
    emailSent,
    devConsole,
    otpHint: devConsole
      ? "Email could not be sent. Check the backend terminal for your 6-digit OTP code."
      : undefined,
  };
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
  const { emailDeliveryConfigured } = await import("./mailer.js");
  if (!emailDeliveryConfigured()) return { ok: true, skipped: true };
  if (!code) {
    await issueOtp(email, purpose);
    return { ok: false, otpRequired: true };
  }
  return verifyOtp(email, purpose, code);
}

/** Returns true if the request may continue. Sends OTP JSON / 400 when not. */
export async function otpGate(req, res, purpose) {
  const gate = await requireOtpOrSkip(req.user?.email, purpose, req.body?.otp || req.query?.otp);
  if (gate.otpRequired) {
    res.json({ otpRequired: true });
    return false;
  }
  if (!gate.ok) {
    res.status(400).json({ error: gate.error || "Invalid OTP" });
    return false;
  }
  return true;
}
