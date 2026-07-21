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

export function sendText(to, body, creds) {
  return send({ to, type: "text", text: { body } }, creds);
}

export function sendButtons(to, bodyText, buttons, creds) {
  return send({
    to,
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

export function sendTemplate(to, name, lang = "en", creds) {
  return send({ to, type: "template", template: { name, language: { code: lang } } }, creds);
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
    to,
    type: "template",
    template: { name, language: { code: lang }, components },
  }, creds);
}

export async function createTemplate(payload, creds) {
  const wabaId = creds?.wabaId || WA.wabaId;
  const accessToken = creds?.accessToken || WA.accessToken;
  if (!wabaId || !accessToken) throw new Error("WABA credentials missing");
  const version = WA.version || "v22.0";
  const res = await fetch(`https://graph.facebook.com/${version}/${wabaId}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

export async function listTemplates(creds) {
  const wabaId = creds?.wabaId || WA.wabaId;
  const accessToken = creds?.accessToken || WA.accessToken;
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

/** Load default WhatsAppAccount creds for a company (or null). */
export async function getCompanyCreds(companyId) {
  if (!companyId) return null;
  const { prisma } = await import("./prisma.js");
  const wa = await prisma.whatsAppAccount.findFirst({
    where: { companyId, isConnected: true },
    orderBy: { isDefault: "desc" },
  });
  if (!wa?.accessToken || !wa?.phoneNumberId) return null;
  return {
    phoneNumberId: wa.phoneNumberId,
    accessToken: wa.accessToken,
    wabaId: wa.wabaId,
  };
}

export { WA_LIVE };
