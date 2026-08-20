// lib/integrations.js — Interakt-style app integrations
import crypto from "crypto";
import { prisma, pickColor } from "./prisma.js";
import { digitsOnly, findCompanyContactByPhone } from "./phone.js";
import { getEffectiveCreds, assertLiveCreds, sendText } from "./whatsappService.js";

export const INTEGRATION_CATALOG = [
  {
    id: "woocommerce",
    name: "WooCommerce",
    category: "E-commerce Platform",
    pricing: "free",
    desc: "Send automatic WhatsApp notifications to recover abandoned carts, confirm COD orders & sync customers.",
    video: "https://woocommerce.com/document/woocommerce-rest-api/",
  },
  {
    id: "shopify",
    name: "Shopify",
    category: "E-commerce Platform",
    pricing: "free",
    desc: "Auto-sync Shopify customers, abandoned checkouts & orders into Nexwapi WhatsApp workflows.",
    video: "https://shopify.dev/docs/api/admin-rest",
  },
  {
    id: "google_sheets",
    name: "Google Sheets",
    category: "Data Storage",
    pricing: "free",
    desc: "Send automatic WhatsApp notifications whenever a new row is added in a sheet.",
    video: "https://developers.google.com/sheets/api",
  },
  {
    id: "facebook_leads",
    name: "Facebook Lead Form",
    category: "Ads Platform",
    pricing: "free",
    desc: "As soon as a user fills the form, add them to Nexwapi & send a welcome WhatsApp notification.",
    video: "https://developers.facebook.com/docs/marketing-api/guides/lead-ads/",
  },
  {
    id: "own_api",
    name: "Own API",
    category: "Developer",
    pricing: "free",
    desc: "Connect your backend with Nexwapi REST API keys — send messages, sync contacts & orders programmatically.",
    video: "",
  },
  {
    id: "razorpay",
    name: "Razorpay",
    category: "Payment Provider",
    pricing: "free",
    desc: "When customers send WhatsApp carts, send Razorpay payment links automatically in checkout bot flow.",
    video: "https://razorpay.com/docs/",
  },
];

function publicBase() {
  return String(process.env.PUBLIC_API_URL || process.env.APP_URL || "https://api.nexwapi.com")
    .replace(/\/$/, "")
    .replace(/\/api$/, "");
}

function maskSecret(value) {
  const s = String(value || "");
  if (s.length < 8) return s ? "••••" : "";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function sanitizeConfig(provider, config = {}) {
  const c = { ...(config || {}) };
  const secretKeys = [
    "consumerSecret", "accessToken", "apiKey", "apiSecret", "privateKey",
    "pageAccessToken", "appSecret", "password", "token",
  ];
  const out = { ...c };
  for (const k of secretKeys) {
    if (out[k]) out[`${k}Masked`] = maskSecret(out[k]);
    delete out[k];
  }
  // Keep non-secret fields
  return out;
}

export function serializeIntegration(row) {
  const catalog = INTEGRATION_CATALOG.find((x) => x.id === row.provider) || {};
  return {
    id: row.id,
    provider: row.provider,
    name: row.name || catalog.name || row.provider,
    status: row.status,
    category: catalog.category || "Other",
    pricing: catalog.pricing || "free",
    desc: catalog.desc || "",
    video: catalog.video || "",
    config: sanitizeConfig(row.provider, row.config),
    webhookSecret: row.webhookSecret ? maskSecret(row.webhookSecret) : "",
    webhookUrl: `${publicBase()}/api/integrations/hooks/${row.provider}/${row.companyId}`,
    lastSyncAt: row.lastSyncAt?.getTime?.() || null,
    lastError: row.lastError || "",
    eventCount: row.eventCount || 0,
    connectedAt: row.connectedAt?.getTime?.() || null,
    createdAt: row.createdAt?.getTime?.() || null,
    updatedAt: row.updatedAt?.getTime?.() || null,
  };
}

export async function listIntegrationsOverview(companyId) {
  const rows = await prisma.integration.findMany({ where: { companyId } });
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const apiKeyCount = await prisma.apiKey.count({ where: { companyId } });

  // Own API is "connected" if company has at least one API key
  if (apiKeyCount > 0 && !byProvider.has("own_api")) {
    // virtual status only in overview
  }

  return INTEGRATION_CATALOG.map((app) => {
    const row = byProvider.get(app.id);
    if (app.id === "own_api") {
      const connected = apiKeyCount > 0 || row?.status === "connected";
      return {
        ...app,
        connection: row
          ? { ...serializeIntegration(row), status: connected ? "connected" : row.status, apiKeyCount }
          : {
              provider: "own_api",
              status: connected ? "connected" : "disconnected",
              apiKeyCount,
              webhookUrl: `${publicBase()}/api/v1/messages`,
              config: {},
            },
      };
    }
    return {
      ...app,
      connection: row ? serializeIntegration(row) : { provider: app.id, status: "disconnected", config: {} },
    };
  });
}

export async function getOrCreateIntegration(companyId, provider) {
  let row = await prisma.integration.findUnique({
    where: { companyId_provider: { companyId, provider } },
  });
  if (!row) {
    row = await prisma.integration.create({
      data: {
        companyId,
        provider,
        name: INTEGRATION_CATALOG.find((x) => x.id === provider)?.name || provider,
        webhookSecret: crypto.randomBytes(16).toString("hex"),
        config: {},
      },
    });
  }
  return row;
}

export async function connectIntegration(companyId, provider, config = {}) {
  const allowed = INTEGRATION_CATALOG.map((x) => x.id);
  if (!allowed.includes(provider)) {
    throw Object.assign(new Error("Unknown integration"), { status: 400 });
  }

  const existing = await getOrCreateIntegration(companyId, provider);
  const prev = typeof existing.config === "object" && existing.config ? existing.config : {};
  const merged = { ...prev };

  for (const [k, v] of Object.entries(config || {})) {
    if (v === undefined || v === null || v === "") continue;
    // Don't overwrite secrets with masked placeholders
    if (String(v).includes("…") || String(v).includes("••••")) continue;
    merged[k] = v;
  }

  // Provider-specific validation
  if (provider === "woocommerce") {
    if (!merged.storeUrl || !merged.consumerKey || !merged.consumerSecret) {
      throw Object.assign(new Error("WooCommerce requires storeUrl, consumerKey and consumerSecret"), { status: 400 });
    }
    merged.storeUrl = String(merged.storeUrl).replace(/\/$/, "");
    await testWooCommerce(merged);
  }
  if (provider === "shopify") {
    if (!merged.shopDomain || !merged.accessToken) {
      throw Object.assign(new Error("Shopify requires shopDomain and accessToken"), { status: 400 });
    }
    merged.shopDomain = String(merged.shopDomain).replace(/^https?:\/\//, "").replace(/\/$/, "");
    await testShopify(merged);
  }
  if (provider === "google_sheets") {
    if (!merged.spreadsheetId) {
      throw Object.assign(new Error("Google Sheets requires spreadsheetId"), { status: 400 });
    }
  }
  if (provider === "facebook_leads") {
    if (!merged.pageAccessToken) {
      throw Object.assign(new Error("Facebook Lead Form requires pageAccessToken"), { status: 400 });
    }
  }
  if (provider === "razorpay") {
    if (!merged.keyId || !merged.keySecret) {
      throw Object.assign(new Error("Razorpay requires keyId and keySecret"), { status: 400 });
    }
  }
  if (provider === "own_api") {
    // Mark connected when user confirms; keys managed on Developer page
  }

  const updated = await prisma.integration.update({
    where: { id: existing.id },
    data: {
      config: merged,
      status: "connected",
      connectedAt: existing.connectedAt || new Date(),
      lastError: "",
      lastSyncAt: new Date(),
    },
  });
  const serialized = serializeIntegration(updated);
  return {
    ...serialized,
    webhookSecretFull: updated.webhookSecret,
    webhookUrl: serialized.webhookUrl,
  };
}

export async function disconnectIntegration(companyId, provider) {
  const row = await prisma.integration.findUnique({
    where: { companyId_provider: { companyId, provider } },
  });
  if (!row) return { ok: true };
  const updated = await prisma.integration.update({
    where: { id: row.id },
    data: { status: "disconnected", lastError: "" },
  });
  return serializeIntegration(updated);
}

/** Rotate webhook secret — returns full secret once. */
export async function rotateIntegrationSecret(companyId, provider) {
  const row = await getOrCreateIntegration(companyId, provider);
  const webhookSecret = crypto.randomBytes(16).toString("hex");
  const updated = await prisma.integration.update({
    where: { id: row.id },
    data: { webhookSecret },
  });
  return {
    ...serializeIntegration(updated),
    webhookSecretFull: webhookSecret,
  };
}

async function testWooCommerce(config) {
  const url = `${config.storeUrl}/wp-json/wc/v3/system_status`;
  const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    // Fallback: try products endpoint (some stores hide system_status)
    const res2 = await fetch(`${config.storeUrl}/wp-json/wc/v3/products?per_page=1`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res2.ok) {
      const body = await res2.text().catch(() => "");
      throw Object.assign(new Error(`WooCommerce auth failed (${res2.status}): ${body.slice(0, 160)}`), { status: 400 });
    }
  }
}

async function testShopify(config) {
  const domain = config.shopDomain.includes(".") ? config.shopDomain : `${config.shopDomain}.myshopify.com`;
  const res = await fetch(`https://${domain}/admin/api/2024-01/shop.json`, {
    headers: { "X-Shopify-Access-Token": config.accessToken },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`Shopify auth failed (${res.status}): ${body.slice(0, 160)}`), { status: 400 });
  }
}

async function upsertContactFromLead(companyId, { name, phone, email, tags = [], attributes = {} }) {
  const cleaned = digitsOnly(phone);
  if (!cleaned || cleaned.length < 8) return null;
  let contact = await findCompanyContactByPhone(prisma, companyId, cleaned);
  if (contact) {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: {
        name: name || contact.name,
        email: email || contact.email || "",
        tags: Array.from(new Set([...(contact.tags || []), ...tags])),
        attributes: { ...(contact.attributes || {}), ...attributes },
      },
    });
  } else {
    const count = await prisma.contact.count({ where: { companyId } });
    contact = await prisma.contact.create({
      data: {
        companyId,
        name: name || `+${cleaned}`,
        phone: cleaned,
        email: email || "",
        tags,
        color: pickColor(count),
        attributes,
        optedIn: true,
      },
    });
  }
  return contact;
}

async function maybeWelcomeWhatsApp(companyId, contact, message) {
  if (!message || !contact?.phone) return;
  try {
    const creds = await getEffectiveCreds(companyId);
    assertLiveCreds(creds);
    await sendText(contact.phone, message, creds);
  } catch (e) {
    console.warn("[integrations] welcome WA:", e.message);
  }
}

async function bumpIntegration(companyId, provider, patch = {}) {
  await prisma.integration.updateMany({
    where: { companyId, provider },
    data: {
      eventCount: { increment: 1 },
      lastSyncAt: new Date(),
      ...patch,
    },
  });
}

/** Verify webhook secret header or query token. */
export async function resolveHookCompany(provider, companyId, req) {
  const row = await prisma.integration.findUnique({
    where: { companyId_provider: { companyId, provider } },
  });
  if (!row || row.status !== "connected") {
    const err = new Error("Integration not connected");
    err.status = 404;
    throw err;
  }
  const secret = row.webhookSecret;
  const header =
    req.headers["x-nexwapi-secret"] ||
    req.headers["x-wc-webhook-secret"] ||
    req.headers["x-shopify-hmac-sha256"] ||
    req.query?.secret ||
    "";
  // Soft verify: if secret configured and client sent one, must match (except Shopify HMAC which is different)
  if (provider !== "shopify" && secret && header && String(header) !== secret) {
    const err = new Error("Invalid webhook secret");
    err.status = 401;
    throw err;
  }
  return row;
}

export async function handleWooWebhook(companyId, topic, payload) {
  const row = await resolveConnected(companyId, "woocommerce");
  const cfg = row.config || {};
  const welcome = cfg.welcomeMessage || "Thanks for your order! We'll update you on WhatsApp.";

  if (/order/i.test(topic || "") || payload?.id) {
    const billing = payload.billing || {};
    const phone = billing.phone || payload.phone || "";
    const name = [billing.first_name, billing.last_name].filter(Boolean).join(" ") || payload.customer_name || "Customer";
    const email = billing.email || payload.email || "";
    const contact = await upsertContactFromLead(companyId, {
      name,
      phone,
      email,
      tags: ["woocommerce", topic || "order"],
      attributes: {
        woo_order_id: String(payload.id || ""),
        woo_status: payload.status || "",
        source: "woocommerce",
      },
    });
    if (contact && cfg.sendWelcome !== false) {
      await maybeWelcomeWhatsApp(companyId, contact, welcome.replace("{{name}}", name));
    }
  }

  if (/checkout|cart/i.test(topic || "")) {
    const phone = payload?.billing?.phone || payload?.phone || "";
    const name = payload?.billing?.first_name || "there";
    const contact = await upsertContactFromLead(companyId, {
      name,
      phone,
      email: payload?.billing?.email || "",
      tags: ["woocommerce", "abandoned_cart"],
      attributes: { source: "woocommerce_cart" },
    });
    if (contact) {
      const msg = cfg.abandonedCartMessage || `Hi ${name}! You left items in your cart. Reply here to complete your order on WhatsApp.`;
      await maybeWelcomeWhatsApp(companyId, contact, msg);
    }
  }

  await bumpIntegration(companyId, "woocommerce");
  return { ok: true };
}

export async function handleShopifyWebhook(companyId, topic, payload) {
  await resolveConnected(companyId, "shopify");
  const cfg = (await getOrCreateIntegration(companyId, "shopify")).config || {};
  const customer = payload.customer || payload.billing_address || {};
  const phone = customer.phone || payload.phone || payload.billing_address?.phone || "";
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ")
    || customer.name
    || "Customer";
  const email = customer.email || payload.email || "";

  const contact = await upsertContactFromLead(companyId, {
    name,
    phone,
    email,
    tags: ["shopify", String(topic || "order").replace(/\//g, "_")],
    attributes: {
      shopify_id: String(payload.id || ""),
      source: "shopify",
    },
  });

  if (contact && /checkout/i.test(topic || "")) {
    const msg = cfg.abandonedCartMessage || `Hi ${name}! Complete your Shopify checkout on WhatsApp — reply YES to continue.`;
    await maybeWelcomeWhatsApp(companyId, contact, msg);
  } else if (contact && cfg.sendWelcome !== false) {
    const msg = cfg.welcomeMessage || `Thanks ${name}! Your Shopify order update will come on WhatsApp.`;
    await maybeWelcomeWhatsApp(companyId, contact, msg);
  }

  await bumpIntegration(companyId, "shopify");
  return { ok: true };
}

export async function handleGoogleSheetRow(companyId, body) {
  await resolveConnected(companyId, "google_sheets");
  const cfg = (await getOrCreateIntegration(companyId, "google_sheets")).config || {};
  const name = body.name || body.Name || body.full_name || "Lead";
  const phone = body.phone || body.Phone || body.mobile || body.Mobile || "";
  const email = body.email || body.Email || "";
  const contact = await upsertContactFromLead(companyId, {
    name,
    phone,
    email,
    tags: ["google_sheets"],
    attributes: { source: "google_sheets", row: body },
  });
  if (contact) {
    const msg = (cfg.welcomeMessage || "Hi {{name}}! Thanks for submitting — how can we help on WhatsApp?")
      .replace(/\{\{name\}\}/g, name);
    await maybeWelcomeWhatsApp(companyId, contact, msg);
  }
  await bumpIntegration(companyId, "google_sheets");
  return { ok: true, contactId: contact?.id || null };
}

export async function handleFacebookLead(companyId, body) {
  await resolveConnected(companyId, "facebook_leads");
  const cfg = (await getOrCreateIntegration(companyId, "facebook_leads")).config || {};
  // Accept either raw leadgen field_data or flattened payload
  let name = body.name || body.full_name || "";
  let phone = body.phone || body.phone_number || "";
  let email = body.email || "";

  if (Array.isArray(body.field_data)) {
    for (const f of body.field_data) {
      const key = String(f.name || "").toLowerCase();
      const val = Array.isArray(f.values) ? f.values[0] : f.value;
      if (/name|full_name/.test(key)) name = val;
      if (/phone|mobile/.test(key)) phone = val;
      if (/email/.test(key)) email = val;
    }
  }

  // Optional: fetch lead from Meta if leadgen_id + token present
  if ((!phone || !name) && body.leadgen_id && cfg.pageAccessToken) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v22.0/${body.leadgen_id}?access_token=${encodeURIComponent(cfg.pageAccessToken)}`
      );
      const data = await res.json();
      if (Array.isArray(data.field_data)) {
        for (const f of data.field_data) {
          const key = String(f.name || "").toLowerCase();
          const val = Array.isArray(f.values) ? f.values[0] : "";
          if (/name|full_name/.test(key) && !name) name = val;
          if (/phone|mobile/.test(key) && !phone) phone = val;
          if (/email/.test(key) && !email) email = val;
        }
      }
    } catch (e) {
      console.warn("[fb leads] fetch:", e.message);
    }
  }

  const contact = await upsertContactFromLead(companyId, {
    name: name || "FB Lead",
    phone,
    email,
    tags: ["facebook_leads"],
    attributes: { source: "facebook_leads", leadgen_id: body.leadgen_id || "" },
  });

  if (contact) {
    const msg = (cfg.welcomeMessage || "Hi {{name}}! Thanks for your interest. How can we help you today?")
      .replace(/\{\{name\}\}/g, name || "there");
    await maybeWelcomeWhatsApp(companyId, contact, msg);
  }

  await bumpIntegration(companyId, "facebook_leads");
  return { ok: true, contactId: contact?.id || null };
}

async function resolveConnected(companyId, provider) {
  const row = await prisma.integration.findUnique({
    where: { companyId_provider: { companyId, provider } },
  });
  if (!row || row.status !== "connected") {
    const err = new Error(`${provider} is not connected`);
    err.status = 404;
    throw err;
  }
  return row;
}

export async function syncWooProducts(companyId) {
  const row = await resolveConnected(companyId, "woocommerce");
  const cfg = row.config || {};
  const auth = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString("base64");
  const res = await fetch(`${cfg.storeUrl}/wp-json/wc/v3/products?per_page=50&status=publish`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw Object.assign(new Error("Failed to fetch Woo products"), { status: 400 });
  const products = await res.json();
  let count = 0;
  for (const p of products) {
    const retailerId = `woo_${p.id}`;
    const existing = await prisma.product.findFirst({ where: { companyId, retailerId } });
    const data = {
      name: p.name || "Product",
      price: String(p.price || p.regular_price || ""),
      description: String(p.short_description || "").replace(/<[^>]+>/g, "").slice(0, 500),
      imageUrl: p.images?.[0]?.src || "",
      retailerId,
      source: "woocommerce",
      currency: "INR",
    };
    if (existing) await prisma.product.update({ where: { id: existing.id }, data });
    else await prisma.product.create({ data: { companyId, ...data } });
    count += 1;
  }
  await bumpIntegration(companyId, "woocommerce");
  return { ok: true, count };
}

export async function syncShopifyProducts(companyId) {
  const row = await resolveConnected(companyId, "shopify");
  const cfg = row.config || {};
  const domain = cfg.shopDomain.includes(".") ? cfg.shopDomain : `${cfg.shopDomain}.myshopify.com`;
  const res = await fetch(`https://${domain}/admin/api/2024-01/products.json?limit=50`, {
    headers: { "X-Shopify-Access-Token": cfg.accessToken },
  });
  if (!res.ok) throw Object.assign(new Error("Failed to fetch Shopify products"), { status: 400 });
  const data = await res.json();
  let count = 0;
  for (const p of data.products || []) {
    const variant = p.variants?.[0];
    const retailerId = `shopify_${p.id}`;
    const existing = await prisma.product.findFirst({ where: { companyId, retailerId } });
    const payload = {
      name: p.title || "Product",
      price: String(variant?.price || ""),
      description: String(p.body_html || "").replace(/<[^>]+>/g, "").slice(0, 500),
      imageUrl: p.image?.src || p.images?.[0]?.src || "",
      retailerId,
      source: "shopify",
      currency: "INR",
    };
    if (existing) await prisma.product.update({ where: { id: existing.id }, data: payload });
    else await prisma.product.create({ data: { companyId, ...payload } });
    count += 1;
  }
  await bumpIntegration(companyId, "shopify");
  return { ok: true, count };
}
