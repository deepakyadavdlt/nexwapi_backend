// lib/whatsappService.js
// One low-level send() plus helpers for text, template, and template-with-variables.
// Falls back to a simulated response when WA_LIVE is false (no real Meta creds).
import { WA, WA_BASE, WA_LIVE } from "../config/whatsapp.js";
import { nanoid } from "nanoid";

function simulate(payload) {
  const id = "wamid.DEMO" + nanoid(18);
  console.log("[whatsapp:demo] would send ->", JSON.stringify(payload));
  return { messaging_product: "whatsapp", messages: [{ id }], demo: true };
}

// Low-level call to the WhatsApp messages endpoint
async function send(payload) {
  if (!WA_LIVE) return simulate(payload);

  const res = await fetch(`${WA_BASE}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`WhatsApp send failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data; // contains messages[0].id
}

// Plain text — ONLY within 24h of the user's last message
export function sendText(to, body) {
  return send({ to, type: "text", text: { body } });
}

// Interactive reply buttons (max 3) — used by the chatbot flow builder.
// Only valid within the 24h customer-service window.
export function sendButtons(to, bodyText, buttons) {
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
  });
}

// Template — for business-initiated messages (no variables)
export function sendTemplate(to, name, lang = "en") {
  return send({ to, type: "template", template: { name, language: { code: lang } } });
}

/* ------------------------------- Media -------------------------------- */
// Upload a file to WhatsApp; returns a media id (or null in demo mode).
export async function uploadMedia(buffer, mimetype, filename) {
  if (!WA_LIVE) return null;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mimetype }), filename);
  const res = await fetch(`${WA_BASE}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA.accessToken}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`media upload failed: ${JSON.stringify(data)}`);
  return data.id;
}

// Send a previously-uploaded media file by id (image | document | video | audio).
export function sendMediaById(to, waType, mediaId, { filename, caption } = {}) {
  const media = { id: mediaId };
  if (caption) media.caption = caption;
  if (waType === "document" && filename) media.filename = filename;
  return send({ to, type: waType, [waType]: media });
}

// Resumable upload → returns a media "handle" used in template example headers.
export async function uploadMediaHandle(buffer, mimetype) {
  if (!WA_LIVE || !WA.appId) throw new Error("Live mode + WHATSAPP_APP_ID required for media templates");
  const start = await fetch(`https://graph.facebook.com/${WA.version}/${WA.appId}/uploads?file_length=${buffer.length}&file_type=${encodeURIComponent(mimetype)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA.accessToken}` },
  });
  const s = await start.json();
  if (!s.id) throw new Error(`upload session failed: ${JSON.stringify(s)}`);
  const up = await fetch(`https://graph.facebook.com/${WA.version}/${s.id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${WA.accessToken}`, file_offset: "0" },
    body: buffer,
  });
  const u = await up.json();
  if (!u.h) throw new Error(`upload failed: ${JSON.stringify(u)}`);
  return u.h;
}

// Create a carousel template (body + cards with image header + buttons).
export async function createCarouselTemplate({ name, category, language, body, cards }) {
  const cardComponents = [];
  for (const card of cards) {
    // Upload the card image to get a header handle.
    const imgRes = await fetch(card.imageUrl);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const mimetype = imgRes.headers.get("content-type") || "image/jpeg";
    const handle = await uploadMediaHandle(buffer, mimetype);
    const comps = [
      { type: "HEADER", format: "IMAGE", example: { header_handle: [handle] } },
      { type: "BODY", text: card.body || " " },
    ];
    const buttons = (card.buttons || []).filter((b) => b.text).map((b) =>
      b.type === "URL"
        ? { type: "URL", text: b.text, url: b.url || "https://nexwapi.com" }
        : { type: "QUICK_REPLY", text: b.text }
    );
    if (buttons.length) comps.push({ type: "BUTTONS", buttons });
    cardComponents.push({ components: comps });
  }
  const res = await fetch(`https://graph.facebook.com/${WA.version}/${WA.wabaId}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name, language, category: String(category).toUpperCase(),
      components: [{ type: "BODY", text: body }, { type: "CAROUSEL", cards: cardComponents }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Carousel create failed: ${JSON.stringify(data)}`);
  return data;
}

// Download inbound media by id → { buffer, mimetype }.
export async function fetchInboundMedia(mediaId) {
  if (!WA_LIVE) return null;
  const metaRes = await fetch(`https://graph.facebook.com/${WA.version}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WA.accessToken}` },
  });
  const meta = await metaRes.json();
  if (!meta.url) return null;
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${WA.accessToken}` } });
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimetype: meta.mime_type || "application/octet-stream" };
}

// Template with body variables, e.g. an OTP code {{1}}
export function sendTemplateWithParams(to, name, params, lang = "en") {
  return send({
    to,
    type: "template",
    template: {
      name,
      language: { code: lang },
      components: [
        {
          type: "body",
          parameters: params.map((text) => ({ type: "text", text })),
        },
      ],
    },
  });
}

// Example: send an OTP using the approved 'otp_login' template
export async function sendOtpOnWhatsApp(phone, code) {
  const result = await sendTemplateWithParams(phone, "otp_login", [code], "en");
  console.log("[whatsapp] otp sent, message id:", result.messages?.[0]?.id);
  return result;
}

const GRAPH = `https://graph.facebook.com/${WA.version}`;

// Upload a sample image to the app and return a resumable-upload handle (for image-header templates).
async function uploadTemplateSample(imageUrl) {
  if (!WA.appId) throw new Error("WHATSAPP_APP_ID not set (needed for image-header templates)");
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error("could not download header image");
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const type = imgRes.headers.get("content-type") || "image/jpeg";
  const sessRes = await fetch(
    `${GRAPH}/${WA.appId}/uploads?file_length=${buf.length}&file_type=${encodeURIComponent(type)}&access_token=${WA.accessToken}`,
    { method: "POST" }
  );
  const sess = await sessRes.json();
  if (!sess.id) throw new Error("upload session failed: " + JSON.stringify(sess));
  const upRes = await fetch(`${GRAPH}/${sess.id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${WA.accessToken}`, file_offset: "0" },
    body: buf,
  });
  const up = await upRes.json();
  if (!up.h) throw new Error("sample upload failed: " + JSON.stringify(up));
  return up.h;
}

// Submit a new message template to Meta for approval (WABA-level).
// Supports optional header (text/image) and buttons (quick-reply / URL).
export async function createTemplate({ name, category = "UTILITY", language = "en", body, headerType, headerText, headerImageUrl, buttons }) {
  if (!WA_LIVE) return { id: "DEMO", status: "PENDING", demo: true };
  const components = [];

  if (headerType === "text" && headerText) {
    components.push({ type: "HEADER", format: "TEXT", text: headerText });
  } else if (headerType === "image" && headerImageUrl) {
    const handle = await uploadTemplateSample(headerImageUrl);
    components.push({ type: "HEADER", format: "IMAGE", example: { header_handle: [handle] } });
  }

  const varCount = (body.match(/\{\{\d+\}\}/g) || []).length;
  const bodyComp = { type: "BODY", text: body };
  if (varCount > 0) bodyComp.example = { body_text: [Array.from({ length: varCount }, (_, i) => `Sample${i + 1}`)] };
  components.push(bodyComp);

  const btns = (buttons || []).filter((b) => b.text);
  if (btns.length) {
    components.push({
      type: "BUTTONS",
      buttons: btns.slice(0, 3).map((b) =>
        b.type === "url" ? { type: "URL", text: b.text, url: b.url } : { type: "QUICK_REPLY", text: b.text }
      ),
    });
  }

  const res = await fetch(`${GRAPH}/${WA.wabaId}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, language, category: String(category).toUpperCase(), components }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Template create failed: ${res.status} ${JSON.stringify(data)}`);
  return data; // { id, status, category }
}

// Fetch all templates (with live status) from Meta for the WABA.
export async function listTemplates() {
  if (!WA_LIVE) return [];
  const res = await fetch(
    `${GRAPH}/${WA.wabaId}/message_templates?fields=name,status,category,language&limit=200`,
    { headers: { Authorization: `Bearer ${WA.accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`List templates failed: ${JSON.stringify(data)}`);
  return data.data || [];
}
