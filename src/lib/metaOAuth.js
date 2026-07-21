// lib/metaOAuth.js — Embedded Signup / Facebook Login token exchange
import { WA } from "../config/whatsapp.js";

const VERSION = process.env.WHATSAPP_API_VERSION || WA.version || "v22.0";
const APP_ID = process.env.WHATSAPP_APP_ID || WA.appId;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || WA.appSecret;
const CONFIG_ID = process.env.WHATSAPP_CONFIG_ID || "";

export function metaSignupConfig() {
  return {
    ready: Boolean(APP_ID && APP_SECRET),
    embeddedReady: Boolean(APP_ID && APP_SECRET && CONFIG_ID),
    appId: APP_ID || null,
    configId: CONFIG_ID || null,
    graphVersion: VERSION,
    redirectUri: process.env.WHATSAPP_REDIRECT_URI || null,
  };
}

/** Exchange OAuth authorization code for a user access token. */
export async function exchangeCodeForToken(code, redirectUri) {
  if (!APP_ID || !APP_SECRET) throw new Error("WHATSAPP_APP_ID / APP_SECRET missing");
  const params = new URLSearchParams({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    code,
  });
  if (redirectUri) params.set("redirect_uri", redirectUri);
  const url = `https://graph.facebook.com/${VERSION}/oauth/access_token?${params}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || "Token exchange failed");
  }
  return data; // { access_token, token_type, expires_in }
}

/**
 * Exchange a short-lived user token for a long-lived token (~60 days).
 * Critical for production — Embedded Signup codes yield short-lived tokens.
 */
export async function exchangeForLongLivedToken(shortLivedToken) {
  if (!APP_ID || !APP_SECRET) throw new Error("WHATSAPP_APP_ID / APP_SECRET missing");
  if (!shortLivedToken) throw new Error("access token required");
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: APP_ID,
    client_secret: APP_SECRET,
    fb_exchange_token: shortLivedToken,
  });
  const url = `https://graph.facebook.com/${VERSION}/oauth/access_token?${params}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || "Long-lived token exchange failed");
  }
  return data; // { access_token, token_type, expires_in }
}

/** Discover WABAs shared with the app after Embedded Signup. */
export async function fetchSharedWabas(accessToken) {
  const res = await fetch(
    `https://graph.facebook.com/${VERSION}/me/businesses?fields=owned_whatsapp_business_accounts{id,name}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) return [];
  const wabas = [];
  for (const biz of data.data || []) {
    for (const w of biz.owned_whatsapp_business_accounts?.data || []) {
      wabas.push({ id: w.id, name: w.name, businessId: biz.id });
    }
  }
  // Fallback: debug_token granular scopes sometimes expose waba ids differently —
  // also try direct shared WABA edge used by some Embedded Signup apps
  if (!wabas.length) {
    const r2 = await fetch(
      `https://graph.facebook.com/${VERSION}/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${APP_ID}|${APP_SECRET}`
    );
    const d2 = await r2.json();
    const scopes = d2?.data?.granular_scopes || [];
    for (const s of scopes) {
      if (s.scope?.includes("whatsapp") && Array.isArray(s.target_ids)) {
        for (const id of s.target_ids) wabas.push({ id, name: null, businessId: null });
      }
    }
  }
  return wabas;
}

/** Debug / inspect token and shared WABAs after Embedded Signup. */
export async function debugToken(inputToken) {
  const params = new URLSearchParams({
    input_token: inputToken,
    access_token: `${APP_ID}|${APP_SECRET}`,
  });
  const res = await fetch(`https://graph.facebook.com/${VERSION}/debug_token?${params}`);
  return res.json();
}

export async function fetchPhoneNumbers(wabaId, accessToken) {
  const res = await fetch(
    `https://graph.facebook.com/${VERSION}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Failed to list phone numbers");
  return data.data || [];
}

/** Subscribe app to WABA webhooks so inbound messages hit our callback. */
export async function subscribeWabaWebhooks(wabaId, accessToken) {
  const res = await fetch(`https://graph.facebook.com/${VERSION}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

export async function fetchPhoneDetails(phoneNumberId, accessToken) {
  const res = await fetch(
    `https://graph.facebook.com/${VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Failed to fetch phone details");
  return data;
}
