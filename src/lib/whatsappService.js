// lib/whatsappService.js
// Tenant-aware WhatsApp Cloud API helpers.
// Pass `creds` { phoneNumberId, accessToken } for per-client sends; else fall back to env.
import { WA, WA_LIVE } from "../config/whatsapp.js";
import { nanoid } from "nanoid";

function simulate(payload) {
  const id = "wamid.DEMO" + nanoid(18);
  console.log("[whatsapp:demo] would send ->", JSON.stringify(payload));
  return { messaging_product: "whatsapp", messages: [{ id }], demo: true };
}

function resolveCreds(creds) {
  if (creds?.incomplete) {
    const err = new Error(
      "WhatsApp Meta credentials are incomplete. Open Dashboard → WhatsApp and reconnect with Facebook."
    );
    err.code = "WA_CREDS_INCOMPLETE";
    err.status = 400;
    throw err;
  }
  const phoneNumberId = creds?.phoneNumberId || WA.phoneNumberId;
  const accessToken = creds?.accessToken || WA.accessToken;
  const live = Boolean(
    phoneNumberId &&
    accessToken &&
    phoneNumberId !== "123456789012345" &&
    !String(accessToken).startsWith("EAAG... ")
  );
  const version = WA.version || "v22.0";
  const base = `https://graph.facebook.com/${version}/${phoneNumberId}`;
  return { phoneNumberId, accessToken, live, base };
}

async function send(payload, creds) {
  const { accessToken, live, base } = resolveCreds(creds);
  if (!live) return simulate(payload);

  const res = await fetch(`${base}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const data = await res.json();
  if (!res.ok || data?.error) throwWaError(data, res.status);
  return data;
}

const META_HINTS = {
  131049: "Meta blocked this marketing template (quality / recipient preference). Use a Utility template, or send only after the customer messages you first.",
  131026: "This number is not on WhatsApp or cannot receive the message. Use country code (e.g. 91…).",
  132001: "Template name/language was not found on this WhatsApp account. Open Templates → Sync from Meta.",
  132015: "Meta paused this template. Create a new Utility template and wait for approval.",
  131047: "24-hour session closed. Send an approved template, not free text.",
  132000: "Template variables do not match Meta ({{1}}, {{2}}, header/buttons). Sync from Meta and fill every variable.",
  131008: "Required template parameter is missing.",
  133010: "Phone number is not registered on Cloud API. Reconnect WhatsApp.",
};

function throwWaError(data, status) {
  const err = data?.error || {};
  const code = err.code;
  const details = err.error_data?.details || err.error_user_msg || err.message || JSON.stringify(data);
  const hint = META_HINTS[code];
  const e = new Error(hint ? `${code}: ${hint}` : code ? `${code}: ${details}` : String(details));
  e.metaCode = code;
  e.status = status >= 400 ? status : 502;
  throw e;
}

/** E.164 digits. 10-digit local IN numbers get 91. */
export function waTo(to) {
  let d = String(to || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0") && d.length === 11) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d;
}

export function waLang(code) {
  const raw = String(code || "en").trim().replace(/-/g, "_");
  if (!raw) return "en_US";
  const lower = raw.toLowerCase();
  if (lower === "en" || lower === "en_us") return "en_US";
  if (lower === "hi" || lower === "hi_in") return "hi_IN";
  const [lang, region] = raw.split("_");
  if (region) return `${lang.toLowerCase()}_${region.toUpperCase()}`;
  return lower;
}

function templateVarCount(text) {
  const nums = [...String(text || "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/**
 * Send an approved template using Meta's live definition (language + body vars).
 * Falls back to the local language/body if the WABA list is unavailable.
 */
export async function sendResolvedTemplate(to, name, { params = [], language, body, creds } = {}) {
  let meta = null;
  try {
    const list = await listTemplates(creds);
    meta = (list || []).find((t) => t.name === name && String(t.status).toUpperCase() === "APPROVED")
      || (list || []).find((t) => t.name === name)
      || null;
  } catch (e) {
    console.warn("[wa] template lookup failed:", e.message);
  }

  if (meta && String(meta.status || "").toUpperCase() === "PAUSED") {
    const err = new Error("132015: Meta paused this template. Create a new Utility template.");
    err.metaCode = 132015;
    err.status = 400;
    throw err;
  }

  const lang = waLang(meta?.language || language || "en");
  const components = [];
  const comps = Array.isArray(meta?.components) ? meta.components : [];
  const bodyComp = comps.find((c) => String(c.type).toUpperCase() === "BODY");
  const headerComp = comps.find((c) => String(c.type).toUpperCase() === "HEADER");
  const bodyText = bodyComp?.text || body || "";
  const bodyVars = templateVarCount(bodyText);
  const headerTextVars = headerComp && String(headerComp.format || "").toUpperCase() === "TEXT"
    ? templateVarCount(headerComp.text || "")
    : 0;

  const filled = Array.from({ length: Math.max(bodyVars, params.length) }, (_, i) => {
    const v = params[i];
    return String(v == null || v === "" ? (params[0] || "Customer") : v).slice(0, 1024);
  });

  if (headerTextVars) {
    components.push({
      type: "header",
      parameters: Array.from({ length: headerTextVars }, (_, i) => ({
        type: "text",
        text: filled[i] || "Customer",
      })),
    });
  }

  if (bodyVars) {
    components.push({
      type: "body",
      parameters: Array.from({ length: bodyVars }, (_, i) => ({
        type: "text",
        text: filled[i] || "Customer",
      })),
    });
  } else if (params.filter(Boolean).length && !meta) {
    components.push({
      type: "body",
      parameters: params.filter(Boolean).map((t) => ({ type: "text", text: String(t) })),
    });
  }

  const buttons = comps.find((c) => String(c.type).toUpperCase() === "BUTTONS")?.buttons || [];
  buttons.forEach((b, idx) => {
    const urlVars = templateVarCount(b.url || "");
    if (String(b.type).toUpperCase() === "URL" && urlVars) {
      components.push({
        type: "button",
        sub_type: "url",
        index: String(idx),
        parameters: Array.from({ length: urlVars }, () => ({ type: "text", text: "https://nexwapi.com" })),
      });
    }
  });

  return send({
    to: waTo(to),
    type: "template",
    template: {
      name,
      language: { code: lang },
      ...(components.length ? { components } : {}),
    },
  }, creds);
}

export function sendText(to, body, creds) {
  return send({ to: waTo(to), type: "text", text: { body } }, creds);
}

export function sendButtons(to, bodyText, buttons, creds) {
  return send({
    to: waTo(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b, i) => ({
          type: "reply",
          reply: { id: b.id || `btn_${i}`, title: String(b.title).slice(0, 20) },
        })),
      },
    },
  }, creds);
}

/** Interactive list message (e.g. product collections). */
export function sendList(to, bodyText, buttonText, sections, creds) {
  return send({
    to: waTo(to),
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: String(bodyText || "").slice(0, 1024) },
      action: {
        button: String(buttonText || "Options").slice(0, 20),
        sections: (sections || []).slice(0, 10).map((s) => ({
          title: String(s.title || "Menu").slice(0, 24),
          rows: (s.rows || []).slice(0, 10).map((r) => ({
            id: String(r.id).slice(0, 200),
            title: String(r.title).slice(0, 24),
            ...(r.description ? { description: String(r.description).slice(0, 72) } : {}),
          })),
        })),
      },
    },
  }, creds);
}

/**
 * Multi-product message (product_list) — requires Meta catalog linked to the WABA.
 * sections: [{ title, product_items: [{ product_retailer_id }] }]
 */
export function sendProductList(to, { catalogId, header, body, footer, sections }, creds) {
  const interactive = {
    type: "product_list",
    header: { type: "text", text: String(header || "Catalog").slice(0, 60) },
    body: { text: String(body || "Browse products").slice(0, 1024) },
    action: {
      catalog_id: String(catalogId),
      sections: (sections || []).slice(0, 10).map((s) => ({
        title: String(s.title || "Items").slice(0, 24),
        product_items: (s.product_items || s.productItems || []).slice(0, 30).map((p) => ({
          product_retailer_id: String(p.product_retailer_id || p.productRetailerId || p),
        })),
      })),
    },
  };
  if (footer) interactive.footer = { text: String(footer).slice(0, 60) };
  return send({ to: waTo(to), type: "interactive", interactive }, creds);
}

/** Full catalog message (single catalog button). */
export function sendCatalogMessage(to, { body, footer }, creds) {
  const interactive = {
    type: "catalog_message",
    body: { text: String(body || "View our catalog").slice(0, 1024) },
    action: { name: "catalog_message" },
  };
  if (footer) interactive.footer = { text: String(footer).slice(0, 60) };
  return send({ to: waTo(to), type: "interactive", interactive }, creds);
}

/** Single product message. */
export function sendSingleProduct(to, { catalogId, productRetailerId, body }, creds) {
  return send({
    to: waTo(to),
    type: "interactive",
    interactive: {
      type: "product",
      body: body ? { text: String(body).slice(0, 1024) } : undefined,
      action: {
        catalog_id: String(catalogId),
        product_retailer_id: String(productRetailerId),
      },
    },
  }, creds);
}

export function sendTemplate(to, name, lang = "en", creds) {
  return send({ to: waTo(to), type: "template", template: { name, language: { code: waLang(lang) } } }, creds);
}

export async function uploadMedia(buffer, mimetype, filename, creds) {
  const { accessToken, live, base } = resolveCreds(creds);
  if (!live) return null;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mimetype }), filename);
  const res = await fetch(`${base}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`media upload failed: ${JSON.stringify(data)}`);
  return data.id;
}

export function sendMediaById(to, waType, mediaId, { filename, caption } = {}, creds) {
  const media = { id: mediaId };
  if (filename) media.filename = filename;
  if (caption) media.caption = caption;
  return send({ to: waTo(to), type: waType, [waType]: media }, creds);
}

export function sendTemplateWithParams(to, name, params = [], lang = "en", creds) {
  const components = params.length
    ? [{ type: "body", parameters: params.map((t) => ({ type: "text", text: String(t) })) }]
    : [];
  return send({
    to: waTo(to),
    type: "template",
    template: { name, language: { code: waLang(lang) }, components },
  }, creds);
}

function bodyExample(text) {
  const nums = [...String(text || "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  if (!nums.length) return undefined;
  const max = Math.max(...nums);
  const row = Array.from({ length: max }, (_, i) => (i === 0 ? "Customer" : `Value ${i + 1}`));
  return { body_text: [row] };
}

/** Map Nexwapi form fields to Meta Cloud API template create payload. */
export function buildMetaTemplatePayload({
  name, category, language, body, headerType, headerText, buttons,
}) {
  const components = [];
  if (headerType === "text" && headerText) {
    components.push({ type: "HEADER", format: "TEXT", text: headerText });
  }
  const example = bodyExample(body);
  components.push({
    type: "BODY",
    text: body,
    ...(example ? { example } : {}),
  });
  if (Array.isArray(buttons) && buttons.length) {
    components.push({
      type: "BUTTONS",
      buttons: buttons.slice(0, 3).map((b) => {
        const t = String(b.type || "QUICK_REPLY").toUpperCase();
        if (t === "URL") return { type: "URL", text: String(b.text || "Open").slice(0, 25), url: b.url };
        return { type: "QUICK_REPLY", text: String(b.text || "OK").slice(0, 25) };
      }),
    });
  }
  return {
    name,
    language: waLang(language),
    category: String(category || "UTILITY").toUpperCase(),
    components,
  };
}

export async function createTemplate(payload, creds) {
  if (creds?.incomplete) throw Object.assign(new Error("WhatsApp is not fully connected"), { status: 400 });
  const wabaId = creds?.wabaId;
  const accessToken = creds?.accessToken;
  if (!wabaId || !accessToken) {
    throw Object.assign(new Error("Connect WhatsApp first — then submit templates on your number."), { status: 400 });
  }
  const version = WA.version || "v22.0";
  const body = payload.components ? payload : buildMetaTemplatePayload(payload);
  const res = await fetch(`https://graph.facebook.com/${version}/${wabaId}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.error_user_msg || data?.error?.message || JSON.stringify(data);
    throw new Error(msg);
  }
  return { ...data, language: body.language };
}

export async function listTemplates(creds) {
  if (creds?.incomplete) return [];
  const wabaId = creds?.wabaId;
  const accessToken = creds?.accessToken;
  if (!wabaId || !accessToken) return [];
  const version = WA.version || "v22.0";
  const res = await fetch(
    `https://graph.facebook.com/${version}/${wabaId}/message_templates?limit=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  return data.data || [];
}

export async function createCarouselTemplate(payload, creds) {
  return createTemplate(payload, creds);
}

export async function fetchInboundMedia(mediaId, creds) {
  const accessToken = creds?.accessToken || WA.accessToken;
  if (!accessToken) return null;
  const version = WA.version || "v22.0";
  const meta = await fetch(`https://graph.facebook.com/${version}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then((r) => r.json());
  if (!meta?.url) return null;
  const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const buffer = Buffer.from(await bin.arrayBuffer());
  return { buffer, mimetype: meta.mime_type || bin.headers.get("content-type") };
}

/**
 * Load default WhatsAppAccount creds for a company.
 * - null: no connected account → callers may fall back to platform env (demo/admin)
 * - { incomplete: true }: number linked but Meta Phone ID / token missing → must NOT fall back
 * - { phoneNumberId, accessToken, wabaId }: live per-tenant sends
 */
export async function getCompanyCreds(companyId) {
  if (!companyId) return null;
  const { prisma } = await import("./prisma.js");
  const wa = await prisma.whatsAppAccount.findFirst({
    where: { companyId, isConnected: true },
    orderBy: { isDefault: "desc" },
  });
  if (!wa) return null;
  if (!wa.accessToken || !wa.phoneNumberId) {
    return { incomplete: true };
  }
  return {
    phoneNumberId: wa.phoneNumberId,
    accessToken: wa.accessToken,
    wabaId: wa.wabaId,
  };
}

/** Tenant creds first. Never send a connected client's campaigns from the platform number. */
export async function getEffectiveCreds(companyId) {
  const tenant = await getCompanyCreds(companyId);
  if (tenant?.incomplete) return tenant;
  if (tenant?.phoneNumberId && tenant?.accessToken) return tenant;
  if (WA_LIVE && WA.phoneNumberId && WA.accessToken && WA.wabaId) {
    return {
      phoneNumberId: WA.phoneNumberId,
      accessToken: WA.accessToken,
      wabaId: WA.wabaId,
      platformFallback: true,
    };
  }
  return tenant;
}

/** Throw a clear 400-style error when tenant WhatsApp is only partially connected. */
export function assertLiveCreds(creds) {
  if (creds?.incomplete) {
    const err = new Error(
      "WhatsApp Meta credentials are incomplete. Open Dashboard → WhatsApp and reconnect with Facebook."
    );
    err.code = "WA_CREDS_INCOMPLETE";
    err.status = 400;
    throw err;
  }
}

/** Campaigns / templates must go out from the workspace number, not Nexwapi platform. */
export function assertTenantOutbound(creds) {
  assertLiveCreds(creds);
  if (creds?.platformFallback || !creds?.phoneNumberId || !creds?.accessToken) {
    const err = new Error(
      "Connect this workspace WhatsApp (Dashboard → WhatsApp) before sending campaigns. Reconnect with Facebook so Phone ID and WABA are saved."
    );
    err.code = "WA_NOT_CONNECTED";
    err.status = 400;
    throw err;
  }
}

export { WA_LIVE };
