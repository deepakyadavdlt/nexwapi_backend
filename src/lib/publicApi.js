// lib/publicApi.js — shared auth for /api/v1/* (Razorpay-style key_id + secret)
import { prisma } from "./prisma.js";
import { findApiKeyByRaw, findApiKeyByIdAndSecret } from "./apiKey.js";
import { hasFeature, normalizePlan } from "./plans.js";

function parseBasicAuth(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { keyId: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

async function resolveApiKeyRecord(req) {
  const basic = parseBasicAuth(req);
  if (basic?.keyId && basic?.secret) {
    const row = await findApiKeyByIdAndSecret(basic.keyId, basic.secret);
    if (row) return row;
  }

  const headerId = req.headers["x-api-key-id"];
  const headerSecret = req.headers["x-api-key-secret"];
  if (headerId && headerSecret) {
    const row = await findApiKeyByIdAndSecret(String(headerId), String(headerSecret));
    if (row) return row;
  }

  const legacy = req.headers["x-api-key"];
  if (legacy) return findApiKeyByRaw(String(legacy));

  return null;
}

/**
 * Resolve + authorize API key. Returns { apiKey, companyId, plan } or sends error response.
 */
export async function requireApiKey(req, res) {
  const apiKey = await resolveApiKeyRecord(req);
  if (!apiKey) {
    const hasAnyAuth = req.headers.authorization
      || req.headers["x-api-key"]
      || req.headers["x-api-key-id"];
    res.status(401).json({
      error: hasAnyAuth ? "Invalid API credentials" : "Missing API credentials",
      code: hasAnyAuth ? "INVALID_API_KEY" : "MISSING_API_KEY",
      hint: "Use Authorization: Basic base64(key_id:key_secret), or headers x-api-key-id + x-api-key-secret, or x-api-key with your secret.",
    });
    return null;
  }

  const plan = normalizePlan(apiKey.company?.plan || "trial");
  if (!hasFeature(plan, "api")) {
    res.status(403).json({
      error: "Your plan does not include API access",
      code: "FEATURE_LOCKED",
      feature: "api",
      plan,
    });
    return null;
  }
  if (apiKey.company?.status === "SUSPENDED") {
    res.status(403).json({ error: "Account suspended", code: "SUSPENDED" });
    return null;
  }

  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return {
    apiKey,
    companyId: apiKey.companyId,
    plan,
    company: apiKey.company,
  };
}

export function apiBaseUrl() {
  const base = String(process.env.PUBLIC_API_URL || "https://api.nexwapi.com").replace(/\/$/, "");
  return `${base}/api`;
}

export function publicApiCatalog() {
  const base = apiBaseUrl();
  return {
    name: "Nexwapi API",
    version: "1",
    baseUrl: base,
    documentation: "https://nexwapi.com/docs/api",
    authentication: {
      recommended: "basic",
      basic: "Authorization: Basic base64(key_id:key_secret)",
      headers: {
        "x-api-key-id": "Your Key ID (nex_live_…)",
        "x-api-key-secret": "Your Key Secret (nex_sk_live_…)",
      },
      legacy: {
        "x-api-key": "Full secret key (nex_sk_live_…)",
      },
    },
    endpoints: [
      { method: "GET", path: `${base}/v1`, description: "API info (no auth)" },
      { method: "GET", path: `${base}/v1/account`, description: "Account + plan probe" },
      { method: "POST", path: `${base}/v1/messages`, description: "Send text or template message" },
      { method: "GET", path: `${base}/v1/contacts`, description: "List/search contacts" },
      { method: "POST", path: `${base}/v1/contacts`, description: "Create or upsert contact" },
      { method: "PATCH", path: `${base}/v1/contacts/:phone/opt-in`, description: "Update opt-in status" },
      { method: "GET", path: `${base}/v1/templates`, description: "List approved templates" },
      { method: "POST", path: `${base}/v1/events`, description: "Track custom contact event" },
    ],
  };
}

export function digitsPhone(to) {
  return String(to || "").replace(/[^\d]/g, "");
}

export function publicContact(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email || null,
    tags: c.tags || [],
    optedIn: c.optedIn !== false,
    attributes: c.attributes || {},
    chatStatus: c.chatStatus || "open",
    createdAt: c.createdAt instanceof Date ? c.createdAt.getTime() : c.createdAt,
  };
}
