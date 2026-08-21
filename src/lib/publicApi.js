// lib/publicApi.js — shared auth for /api/v1/* (x-api-key)
import { prisma } from "./prisma.js";
import { findApiKeyByRaw } from "./apiKey.js";
import { hasFeature, normalizePlan } from "./plans.js";

/**
 * Resolve + authorize API key. Returns { apiKey, companyId, plan } or sends error response.
 */
export async function requireApiKey(req, res) {
  const key = req.headers["x-api-key"];
  if (!key) {
    res.status(401).json({ error: "Missing x-api-key header", code: "MISSING_API_KEY" });
    return null;
  }
  const apiKey = await findApiKeyByRaw(String(key));
  if (!apiKey) {
    res.status(401).json({ error: "Invalid API key", code: "INVALID_API_KEY" });
    return null;
  }
  const plan = normalizePlan(apiKey.company?.plan || "trial");
  if (!hasFeature(plan, "api")) {
    res.status(403).json({
      error: "Your plan does not include api",
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
