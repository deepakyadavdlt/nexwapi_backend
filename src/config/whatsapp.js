// config/whatsapp.js
// Centralised WhatsApp Cloud API configuration — read once and validated.
import "dotenv/config";

export const WA = {
  version: process.env.WHATSAPP_API_VERSION || "v22.0",
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  wabaId: process.env.WHATSAPP_WABA_ID,
  appId: process.env.WHATSAPP_APP_ID,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  appSecret: process.env.WHATSAPP_APP_SECRET,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
};

export const WA_BASE = `https://graph.facebook.com/${WA.version}/${WA.phoneNumberId}`;

// Placeholder values shipped in .env.example — treated as "not configured".
const PLACEHOLDERS = new Set([
  "123456789012345",
  "EAAG...your_permanent_token",
  "your_app_secret",
  "any_random_string_you_choose",
  undefined,
  "",
]);

const isReal = (v) => v && !PLACEHOLDERS.has(v);

// True only when real Meta credentials are present. When false, the service
// runs in "demo mode" and simulates sends so the app works without Meta setup.
export const WA_LIVE = Boolean(isReal(WA.phoneNumberId) && isReal(WA.accessToken));

// Fail soft: warn (don't crash) so the demo experience still boots.
for (const k of ["phoneNumberId", "accessToken", "appSecret", "verifyToken"]) {
  if (!isReal(WA[k])) console.warn(`[whatsapp] missing/placeholder env: ${k}`);
}
