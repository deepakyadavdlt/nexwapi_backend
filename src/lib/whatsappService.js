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
  if (!res.ok) {
    throw new Error(`WhatsApp send failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function waTo(to) {
  return String(to || "").replace(/\D/g, "");
}

function waLang(code) {
  const c = String(code || "en").trim();
  if (c === "en") return "en_US";
  if (c === "hi") return "hi_IN";
  return c;
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
  return send({ to, type: waType, [waType]: media }, creds);
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

/** Tenant creds first; fall back to platform Meta env when live (for admin / unconnected clients). */
export async function getEffectiveCreds(companyId) {
  const tenant = await getCompanyCreds(companyId);
  if (tenant?.incomplete) return tenant;
  if (tenant?.phoneNumberId && tenant?.accessToken && tenant?.wabaId) return tenant;
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

export { WA_LIVE };
