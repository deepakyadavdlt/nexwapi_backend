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

/** Exchange OAuth authorization code for an access token. */
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
 * Embedded Signup (FB.login + config_id): code comes to the JS callback, not a redirect.
 * Meta requires client_id + client_secret + code only — NO redirect_uri.
 * Sending any redirect_uri causes "Error validating verification code".
 */
export async function exchangeEmbeddedSignupCode(code) {
  return exchangeCodeForToken(code);
}

/**
 * Exchange a short-lived user token for a long-lived token (~60 days).
 * Skip for BISU tokens from Embedded Signup v4 — they typically do not expire.
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

/** Debug / inspect token and shared WABAs after Embedded Signup. */
export async function debugToken(inputToken) {
  const params = new URLSearchParams({
    input_token: inputToken,
    access_token: `${APP_ID}|${APP_SECRET}`,
  });
  const res = await fetch(`https://graph.facebook.com/${VERSION}/debug_token?${params}`);
  return res.json();
}

/** Discover WABAs from debug_token granular_scopes (most reliable for BISU tokens). */
export async function discoverWabasFromToken(accessToken) {
  const dbg = await debugToken(accessToken);
  const wabaIds = new Set();
  for (const s of dbg?.data?.granular_scopes || []) {
    if (/whatsapp/i.test(s.scope || "") && Array.isArray(s.target_ids)) {
      for (const id of s.target_ids) wabaIds.add(String(id));
    }
  }
  return [...wabaIds].map((id) => ({ id, name: null, businessId: dbg?.data?.profile_id || null }));
}

/** Discover WABAs shared with the app after Embedded Signup. */
export async function fetchSharedWabas(accessToken) {
  const fromDebug = await discoverWabasFromToken(accessToken);
  if (fromDebug.length) return fromDebug;

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
  return wabas;
}

export async function fetchPhoneNumbers(wabaId, accessToken) {
  const res = await fetch(
    `https://graph.facebook.com/${VERSION}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status`,
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
    `https://graph.facebook.com/${VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,status`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Failed to fetch phone details");
  return data;
}

/**
 * Register the phone number on WhatsApp Cloud API.
 * Until this succeeds, Meta shows status "Pending" and live send/receive won't work.
 */
export async function registerCloudApiPhone(phoneNumberId, accessToken, pin = "123456") {
  const cleanPin = String(pin || "123456").replace(/\D/g, "").padStart(6, "0").slice(0, 6);
  const res = await fetch(`https://graph.facebook.com/${VERSION}/${phoneNumberId}/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", pin: cleanPin }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || "Phone registration failed";
    const err = new Error(msg);
    err.meta = data?.error || data;
    throw err;
  }
  return data;
}

function isAlreadyRegisteredError(err) {
  const msg = String(err?.message || "").toLowerCase();
  const code = err?.meta?.code;
  return (
    /already registered/i.test(msg)
    || /account has been registered/i.test(msg)
    || /already exists/i.test(msg)
    || code === 133016
  );
}

/**
 * Register phone on Cloud API. Meta shows "Pending" until this succeeds.
 * Tries client BISU token first, then partner system user token if configured.
 */
export async function ensureCloudApiPhoneRegistered(phoneNumberId, accessToken, pin) {
  if (!phoneNumberId || !accessToken) {
    return { ok: false, error: "phoneNumberId and accessToken required" };
  }
  const usePin = pin || process.env.WHATSAPP_REGISTER_PIN || "123456";
  const tokens = [accessToken];
  const sysToken = process.env.WHATSAPP_SYSTEM_USER_TOKEN;
  if (sysToken && sysToken !== accessToken) tokens.push(sysToken);

  let lastErr;
  for (const token of tokens) {
    try {
      await registerCloudApiPhone(phoneNumberId, token, usePin);
      return { ok: true, registered: true };
    } catch (e) {
      if (isAlreadyRegisteredError(e)) {
        return { ok: true, registered: true, alreadyRegistered: true };
      }
      lastErr = e;
    }
  }

  const msg = lastErr?.message || "Phone registration failed";
  console.warn("[wa] phone register:", msg);
  return { ok: false, registered: false, error: msg, meta: lastErr?.meta || null };
}
