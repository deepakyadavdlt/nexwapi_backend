// routes/whatsappRoutes.js
// GET = Meta verification handshake. POST = signed event receiver.
// Inbound messages are persisted in Postgres (auto-creating the contact if new)
// and outbound delivery/read statuses are reflected back onto stored messages.
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { WA } from "../config/whatsapp.js";
import { prisma, pickColor } from "../lib/prisma.js";
import { sendText, sendButtons, fetchInboundMedia, getCompanyCreds, assertLiveCreds } from "../lib/whatsappService.js";
import { fireEvent, logActivity } from "../lib/events.js";
import { digitsOnly, findCompanyContactByPhone, looksLikePhone } from "../lib/phone.js";
import { notify } from "../lib/notify.js";
import { assignContactToAgent } from "../lib/assignmentEngine.js";
import { maybeWelcome, maybeAway } from "../lib/inboxAutomations.js";
import { buildTriggerCatalog, matchIntent } from "../lib/intentMatcher.js";
import { maybeAiAgentReply } from "../lib/aiAgent.js";
import { applyTemplateStatusUpdate, syncCompanyTemplates } from "../lib/templateSync.js";
import { handleCallingWebhook } from "../lib/waCalling.js";

const UPLOAD_DIR = path.resolve("uploads");
const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf", "video/mp4": ".mp4", "audio/ogg": ".ogg", "audio/mpeg": ".mp3" };

async function outboundChargeAndSend(companyId, to, sendFn, meta = {}) {
  const creds = await getCompanyCreds(companyId);
  assertLiveCreds(creds);
  if (!creds) {
    const err = new Error("WhatsApp is not connected");
    err.status = 400;
    throw err;
  }
  return sendFn(creds);
}

// Download an inbound media file and return a servable local URL.
async function saveInboundMedia(mediaId, hostUrl, companyId) {
  try {
    const creds = companyId ? await getCompanyCreds(companyId) : null;
    const media = await fetchInboundMedia(mediaId, creds);
    if (!media) return null;
    const name = `in_${mediaId}${EXT[media.mimetype] || ""}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), media.buffer);
    return `${hostUrl}/uploads/${name}`;
  } catch (e) {
    console.error("[wa] inbound media download failed:", e.message);
    return null;
  }
}

/** Resolve tenant companyId from phone_number_id, then WABA id (template webhooks have no phone id). */
async function resolveCompanyId(value, wabaId) {
  const phoneNumberId = value?.metadata?.phone_number_id || null;
  if (phoneNumberId) {
    const acct = await prisma.whatsAppAccount.findFirst({
      where: { phoneNumberId: String(phoneNumberId) },
    });
    if (acct?.companyId) return acct.companyId;
  }
  if (wabaId) {
    const byWaba = await prisma.whatsAppAccount.findFirst({
      where: { wabaId: String(wabaId) },
    });
    if (byWaba?.companyId) return byWaba.companyId;
  }
  if (phoneNumberId && WA.phoneNumberId && String(phoneNumberId) === String(WA.phoneNumberId)) {
    const co = await prisma.company.findFirst({
      where: { status: { in: ["TRIAL", "ACTIVE"] } },
      orderBy: { createdAt: "asc" },
    });
    return co?.id || null;
  }
  if (phoneNumberId || wabaId) {
    console.warn("[webhook] unmatched account", { phoneNumberId, wabaId });
  }
  return null;
}

function keywordHit(lc, keyword) {
  const t = String(keyword || "").trim().toLowerCase();
  if (!t) return false;
  if (t.length <= 3) {
    const parts = lc.split(/[^a-z0-9]+/i).filter(Boolean);
    return lc === t || parts.includes(t);
  }
  return lc.includes(t);
}

async function findAutoReply(text, companyId) {
  const s = await prisma.setting.findUnique({ where: { companyId } }).catch(() => null);
  if (s && s.customRepliesEnabled === false) return null;
  const autos = await prisma.automation.findMany({
    where: { enabled: true, ...(companyId ? { companyId } : {}) },
    orderBy: { createdAt: "asc" },
  });
  // Specific keyword rules before catch-all "any message" rules
  autos.sort((a, b) => {
    if (a.matchType === "any" && b.matchType !== "any") return 1;
    if (b.matchType === "any" && a.matchType !== "any") return -1;
    return 0;
  });
  const lc = (text || "").trim().toLowerCase();
  return autos.find((a) => {
    if (a.matchType === "any") return true;
    if (!a.keyword) return false;
    const keys = a.keyword.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (!keys.length) return false;
    if (a.matchType === "exact") return keys.some((k) => lc === k);
    return keys.some((k) => keywordHit(lc, k));
  });
}

async function autoAssignIfNeeded(contact, companyId, { force = false } = {}) {
  return assignContactToAgent(contact, companyId, { force });
}

/* --------------------------- Chatbot flow engine --------------------------- */
async function sendStep(contact, flow, step, companyId) {
  const cid = companyId || contact.companyId;
  if (step.apiCall?.url) {
    try {
      const resp = await fetch(step.apiCall.url);
      const body = await resp.text();
      let value = body.slice(0, 300);
      try {
        const j = JSON.parse(body);
        value = step.apiCall.field ? String(j[step.apiCall.field] ?? "") : JSON.stringify(j).slice(0, 300);
      } catch {}
      if (step.apiCall.saveField) {
        const attrs = { ...(contact.attributes || {}), [step.apiCall.saveField]: value };
        await prisma.contact.update({ where: { id: contact.id }, data: { attributes: attrs } });
        contact.attributes = attrs;
      }
      console.log("[flow] api-call ->", step.apiCall.url, "saved:", value.slice(0, 40));
    } catch (e) {
      console.error("[flow] api-call failed:", e.message);
    }
    const nextStep = flow.steps.find((s) => s.id === step.apiCall.next);
    if (nextStep) return sendStep(contact, flow, nextStep, cid);
    await prisma.contact.update({ where: { id: contact.id }, data: { activeFlowId: null, activeFlowStep: null } });
    return;
  }

  const buttons = (step.buttons || []).filter((b) => b.title && b.next);
  let r;
  if (buttons.length) {
    r = await outboundChargeAndSend(cid, contact.phone, (creds) =>
      sendButtons(contact.phone, step.message, buttons.map((b) => ({ id: `next:${b.next}`, title: b.title })), creds)
    , { channel: "chatbot" });
  } else {
    r = await outboundChargeAndSend(cid, contact.phone, (creds) =>
      sendText(contact.phone, step.message, creds)
    , { channel: "chatbot" });
  }
  await prisma.message.create({
    data: {
      companyId: cid,
      waId: r.messages?.[0]?.id || null,
      contactId: contact.id,
      direction: "out",
      type: buttons.length ? "interactive" : "text",
      text: step.message,
      status: "sent",
      automationSource: "workflow",
    },
  });
  const waiting = buttons.length > 0 || Boolean(step.capture?.field) || (step.conditions?.length > 0);
  const done = !waiting && !step.apiCall?.next;
  await prisma.contact.update({
    where: { id: contact.id },
    data: waiting ? { activeFlowId: flow.id, activeFlowStep: step.id } : { activeFlowId: null, activeFlowStep: null },
  });
  if (done) logActivity(contact.id, "flow_completed", flow.name || "Workflow");
}

async function runChatbot(contact, m, text, companyId) {
  const cid = companyId || contact.companyId;
  const btnId = m.interactive?.button_reply?.id;
  const lc = (text || "").trim().toLowerCase();

  if (contact.activeFlowId) {
    const flow = await prisma.flow.findFirst({ where: { id: contact.activeFlowId, companyId: cid } });
    if (flow?.enabled && Array.isArray(flow.steps)) {
      const current = flow.steps.find((s) => s.id === contact.activeFlowStep);
      let nextId = btnId?.startsWith("next:") ? btnId.slice(5) : null;
      if (!nextId && current) {
        const btn = (current.buttons || []).find((b) => b.title?.toLowerCase() === lc);
        if (btn) nextId = btn.next;
      }
      if (!nextId && current?.capture?.field) {
        const attrs = { ...(contact.attributes || {}), [current.capture.field]: text };
        await prisma.contact.update({ where: { id: contact.id }, data: { attributes: attrs } });
        contact.attributes = attrs;
        nextId = current.capture.next;
        console.log(`[wa] captured "${current.capture.field}" =`, text);
      }
      if (!nextId && current?.conditions?.length) {
        const cond = current.conditions.find((c) => c.match && lc.includes(c.match.toLowerCase()));
        nextId = cond?.next || current.defaultNext || null;
      }
      const next = nextId ? flow.steps.find((s) => s.id === nextId) : null;
      if (next) { await sendStep(contact, flow, next, cid); return true; }
      await prisma.contact.update({ where: { id: contact.id }, data: { activeFlowId: null, activeFlowStep: null } });
      logActivity(contact.id, "flow_completed", flow.name || "Workflow");
    }
  }

  const flows = await prisma.flow.findMany({ where: { enabled: true, companyId: cid }, orderBy: { createdAt: "asc" } });
  for (const flow of flows) {
    if (!Array.isArray(flow.steps) || !flow.steps.length) continue;
    const match = flow.triggerType === "any" || keywordHit(lc, flow.trigger);
    if (match) {
      await sendStep(contact, flow, flow.steps[0], cid);
      await prisma.flow.update({ where: { id: flow.id }, data: { sentCount: { increment: 1 } } }).catch(() => {});
      return true;
    }
  }
  return false;
}

const router = express.Router();

// Extract readable text from any inbound message type.
function textOf(m) {
  switch (m.type) {
    case "text": return m.text?.body || "";
    case "button": return m.button?.text || "";
    case "interactive": {
      const perm = m.interactive?.call_permission_reply;
      if (m.interactive?.type === "call_permission_reply" || perm) {
        const r = String(perm?.response || "").toLowerCase();
        if (r === "accept" || r === "approve" || r === "granted") return "Allowed WhatsApp calls";
        if (r === "reject" || r === "deny" || r === "declined") return "Declined WhatsApp calls";
        return "Call permission reply";
      }
      return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "";
    }
    case "call_permission_reply": {
      const r = String(m.call_permission_reply?.response || "").toLowerCase();
      if (r === "accept" || r === "approve" || r === "granted") return "Allowed WhatsApp calls";
      if (r === "reject" || r === "deny" || r === "declined") return "Declined WhatsApp calls";
      return "Call permission reply";
    }
    case "order": {
      const items = m.order?.product_items || [];
      return `🛒 Cart · ${items.length} item(s)`;
    }
    case "image": return m.image?.caption || "📷 Photo";
    case "document": return m.document?.filename || "📄 Document";
    case "audio": return "🎤 Voice message";
    case "video": return m.video?.caption || "🎥 Video";
    case "location": return "📍 Location";
    default: return `[${m.type}]`;
  }
}

// 1) Verification handshake (Meta calls this once when you save the URL)
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WA.verifyToken) {
    console.log("[wa] webhook verified ✓");
    return res.status(200).send(challenge);
  }
  console.warn("[wa] webhook verification failed (token mismatch)");
  return res.sendStatus(403);
});

// 2) Event receiver — RAW body is required to verify the signature
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  // Verify Meta's signature when an App Secret is configured (skipped otherwise).
  if (WA.appSecret && WA.appSecret !== "your_app_secret") {
    const signature = req.headers["x-hub-signature-256"];
    const expected =
      "sha256=" + crypto.createHmac("sha256", WA.appSecret).update(req.body).digest("hex");
    const ok =
      signature &&
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!ok) {
      console.warn("[wa] bad signature — rejected");
      return res.status(401).send("bad signature");
    }
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.sendStatus(400);
  }

  // Respond immediately so Meta never retries; process afterwards.
  res.sendStatus(200);

  try {
    for (const entry of event?.entry || []) {
      const wabaId = entry?.id ? String(entry.id) : null;
      for (const change of entry?.changes || []) {
        const value = change?.value;
        if (!value) continue;
        const companyId = await resolveCompanyId(value, wabaId);
        if (change.field === "calls" || (value.calls && value.calls.length)) {
          await handleCallingWebhook(value, companyId).catch((e) =>
            console.warn("[wa] calling webhook", e?.message || e)
          );
        }
        if (change.field === "message_template_status_update" || value.message_template_name) {
          let tplCompanyId = companyId;
          if (!tplCompanyId && wabaId) {
            const byWaba = await prisma.whatsAppAccount.findFirst({
              where: { wabaId: String(wabaId) },
            });
            tplCompanyId = byWaba?.companyId || null;
          }
          const tName = value.message_template_name;
          const tEvent = value.event || value.message_template_status || value.status || "";
          if (tName && tEvent) {
            await applyTemplateStatusUpdate({
              companyId: tplCompanyId,
              name: tName,
              language: value.message_template_language,
              event: tEvent,
            }).catch((e) => console.warn("[wa] template status", e?.message || e));
          }
          if (tplCompanyId) {
            syncCompanyTemplates(tplCompanyId).catch((e) => console.warn("[wa] template sync", e?.message || e));
          } else if (wabaId) {
            console.warn("[wa] template webhook: no company for WABA", wabaId, tName);
          }
        }
        if (!companyId && !(value.statuses || []).length) {
          console.warn("[wa] no company for phone_number_id", value?.metadata?.phone_number_id);
          continue;
        }
        if (companyId) {
          await prisma.whatsAppAccount.updateMany({
            where: { companyId, phoneNumberId: String(value?.metadata?.phone_number_id || "") },
            data: { lastWebhookAt: new Date(), webhookStatus: "connected" },
          }).catch(() => {});
        }

        if (companyId) {
        const profileName = value?.contacts?.[0]?.profile?.name;

        for (const m of value.messages || []) {
          const phone = digitsOnly(m.from);
          let isNewContact = false;
          let contact = await findCompanyContactByPhone(prisma, companyId, phone);
          if (contact) {
            const betterName = profileName && !looksLikePhone(profileName) ? profileName : null;
            if (betterName && looksLikePhone(contact.name)) {
              contact = await prisma.contact.update({ where: { id: contact.id }, data: { name: betterName } });
            }
          } else {
            isNewContact = true;
            const count = await prisma.contact.count({ where: { companyId } });
            const name = profileName && !looksLikePhone(profileName) ? profileName : `+${phone}`;
            contact = await prisma.contact.create({
              data: {
                companyId,
                name,
                phone,
                tags: ["inbound"],
                color: pickColor(count),
              },
            });
          }
          const bodyText = textOf(m);

          let mediaUrl = null;
          let filename = null;
          const mediaObj = m.image || m.document || m.video || m.audio;
          if (mediaObj?.id) {
            const hostUrl = `${req.protocol}://${req.get("host")}`;
            mediaUrl = await saveInboundMedia(mediaObj.id, hostUrl, companyId);
            filename = m.document?.filename || null;
          }

          if (m.id && (await prisma.message.findUnique({ where: { waId: m.id } }))) {
            console.log("[wa] duplicate inbound skipped:", m.id);
            continue;
          }
          await prisma.message.create({
            data: {
              companyId,
              waId: m.id,
              contactId: contact.id,
              direction: "in",
              type: m.type || "text",
              text: bodyText,
              mediaUrl,
              filename,
              status: "delivered",
              at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
            },
          });
          const permReply = m.interactive?.call_permission_reply || m.call_permission_reply;
          if (m.type === "call_permission_reply" || m.interactive?.type === "call_permission_reply" || permReply) {
            const r = String(permReply?.response || "").toLowerCase();
            const accepted = r === "accept" || r === "approve" || r === "granted";
            const { pushCallSignal } = await import("../lib/callBus.js");
            pushCallSignal(companyId, {
              kind: "permission",
              phone,
              contactId: contact.id,
              accepted,
            });
          }
          console.log("[wa] incoming from", m.from, ":", bodyText);
          fireEvent(companyId, "message.received", { from: m.from, name: contact.name, text: bodyText, type: m.type }).catch(() => {});
          notify({
            audience: "client",
            companyId,
            title: `New message from ${contact.name}`,
            body: String(bodyText || m.type || "Incoming WhatsApp").slice(0, 180),
            href: "/dashboard/inbox",
          }).catch(() => {});
          const force = contact.chatStatus === "resolved" || !contact.assignedAgentId;
          const assignedId = await autoAssignIfNeeded(contact, companyId, { force }).catch(() => null);
          if (assignedId) {
            contact = await prisma.contact.findUnique({ where: { id: contact.id } }) || contact;
          }

          // Reset delayed-reply flag so scheduler can fire again for this unanswered message
          if (contact.attributes?.delayed_reply_sent_at) {
            const attrs = { ...(contact.attributes || {}) };
            delete attrs.delayed_reply_sent_at;
            contact = await prisma.contact.update({ where: { id: contact.id }, data: { attributes: attrs } });
          }

          const btnId0 = m.interactive?.button_reply?.id;
          if (btnId0?.startsWith("csat:")) {
            const rating = btnId0.slice(5);
            const attrs = { ...(contact.attributes || {}), csat_rating: rating, csat_at: new Date().toISOString() };
            await prisma.contact.update({ where: { id: contact.id }, data: { attributes: attrs } });
            try {
              const r = await outboundChargeAndSend(companyId, contact.phone, (creds) =>
                sendText(contact.phone, "🙏 Thank you for your feedback!", creds)
              , { channel: "csat" });
              await prisma.message.create({
                data: {
                  companyId,
                  waId: r.messages?.[0]?.id || null,
                  contactId: contact.id,
                  direction: "out",
                  type: "text",
                  text: "🙏 Thank you for your feedback!",
                  status: "sent",
                },
              });
            } catch {}
            console.log("[csat] rating from", contact.phone, "=", rating);
            continue;
          }

          // WhatsApp Commerce: inbound cart / order
          if (m.type === "order" && m.order) {
            try {
              const { handleInboundOrder } = await import("../lib/commerce.js");
              const order = await handleInboundOrder(companyId, contact, m.order, m.id);
              notify({
                audience: "client",
                companyId,
                title: `New WhatsApp cart from ${contact.name}`,
                body: `Order ${order.id.slice(-6).toUpperCase()} · ${order.currency} ${order.totalAmount}`,
                href: "/dashboard/orders",
              }).catch(() => {});
              console.log("[commerce] cart order", order.id, "from", contact.phone);
            } catch (e) {
              console.error("[commerce] order handler:", e.message);
            }
            continue;
          }

          // Collection list reply → send product catalog for that collection
          const listId = m.interactive?.list_reply?.id;
          if (listId?.startsWith("col:")) {
            try {
              const { sendCollectionCatalog } = await import("../lib/commerce.js");
              await sendCollectionCatalog(companyId, contact.phone, listId.slice(4));
              console.log("[commerce] collection catalog sent", listId.slice(4));
            } catch (e) {
              console.error("[commerce] collection reply:", e.message);
            }
            continue;
          }

          // Autocheckout address / payment replies (also button Yes/No)
          try {
            const { continueAutocheckout } = await import("../lib/commerce.js");
            const btnAc = m.interactive?.button_reply?.id || null;
            const handledCheckout = await continueAutocheckout(companyId, contact, bodyText, btnAc);
            if (handledCheckout) {
              console.log("[commerce] autocheckout step", contact.phone, btnAc || bodyText);
              continue;
            }
          } catch (e) {
            console.error("[commerce] autocheckout:", e.message);
          }

          let handled = false;
          try {
            handled = await maybeWelcome(contact, companyId, { isNewContact });
            if (handled) console.log("[wa] welcome sent", m.from);
          } catch (e) {
            console.error("[wa] welcome error:", e.message);
          }
          if (handled) continue;

          try {
            handled = await maybeAway(contact, companyId);
            if (handled) console.log("[wa] OOO sent", m.from);
          } catch (e) {
            console.error("[wa] OOO error:", e.message);
          }
          if (handled) continue;

          try {
            handled = await runChatbot(contact, m, bodyText, companyId);
            if (handled) console.log("[wa] chatbot handled", m.from);
          } catch (e) {
            console.error("[wa] chatbot error:", e.message);
          }
          if (handled) continue;

          const auto = await findAutoReply(bodyText, companyId);
          if (auto) {
            try {
              const r = await outboundChargeAndSend(companyId, m.from, (creds) =>
                sendText(m.from, auto.reply, creds)
              , { channel: "automation", automationId: auto.id });
              await prisma.message.create({
                data: {
                  companyId,
                  waId: r.messages?.[0]?.id || null,
                  contactId: contact.id,
                  direction: "out",
                  type: "text",
                  text: auto.reply,
                  status: "sent",
                  automationSource: "custom_reply",
                },
              });
              await prisma.automation.update({
                where: { id: auto.id },
                data: { sentCount: { increment: 1 } },
              }).catch(() => {});
              console.log(`[wa] auto-replied (${auto.name}) to`, m.from);
            } catch (e) {
              console.error("[wa] auto-reply failed:", e.message);
            }
          } else {
            const setting = await prisma.setting.findUnique({ where: { companyId } }).catch(() => null);
            let intentHandled = false;
            if (setting?.intentMatchingEnabled) {
              const [autos, flows] = await Promise.all([
                prisma.automation.findMany({ where: { enabled: true, companyId } }),
                prisma.flow.findMany({ where: { enabled: true, companyId } }),
              ]);
              const match = matchIntent(bodyText, buildTriggerCatalog(autos, flows));
              if (match?.type === "automation") {
                try {
                  const r = await outboundChargeAndSend(companyId, m.from, (creds) =>
                    sendText(m.from, match.payload.reply, creds)
                  , { channel: "intent", automationId: match.id });
                  await prisma.message.create({
                    data: { companyId, waId: r.messages?.[0]?.id || null, contactId: contact.id, direction: "out", type: "text", text: match.payload.reply, status: "sent", automationSource: "custom_reply" },
                  });
                  await prisma.automation.update({ where: { id: match.id }, data: { sentCount: { increment: 1 } } }).catch(() => {});
                  intentHandled = true;
                  console.log(`[wa] intent matched automation (${match.name})`);
                } catch (e) { console.error("[wa] intent automation failed:", e.message); }
              } else if (match?.type === "flow" && match.payload.steps?.[0]) {
                await sendStep(contact, match.payload, match.payload.steps[0], companyId);
                await prisma.flow.update({ where: { id: match.id }, data: { sentCount: { increment: 1 } } }).catch(() => {});
                intentHandled = true;
                console.log(`[wa] intent matched flow (${match.name})`);
              }
            }
            if (!intentHandled) {
              await maybeAiAgentReply(contact, bodyText, companyId);
            }
          }
        }
        }

        for (const s of value.statuses || []) {
          const next = String(s.status || "").toLowerCase();
          if (!s.id || !next) continue;
          const err0 = Array.isArray(s.errors) ? s.errors[0] : null;
          const errorText = err0
            ? `${err0.code || ""}: ${err0.error_data?.details || err0.title || err0.message || "failed"}`.replace(/^: /, "").trim()
            : null;
          const prev = await prisma.message.findFirst({ where: { waId: s.id } });
          const updated = await prisma.message.updateMany({
            where: { waId: s.id },
            data: { status: next, ...(errorText ? { error: errorText } : {}) },
          });
          if (updated.count === 0) {
            console.log("[wa] status unmatched", s.id, next);
            continue;
          }
          console.log("[wa] status", s.id, "->", next, errorText || "");
          const msg = prev || (await prisma.message.findFirst({ where: { waId: s.id } }));
          const statusCompanyId = companyId || msg?.companyId;
          if (statusCompanyId) {
            fireEvent(statusCompanyId, "message.status", {
              waId: s.id,
              status: next,
              recipient: s.recipient_id || null,
              timestamp: s.timestamp || null,
              error: errorText,
            }).catch(() => {});
          }
          if (msg?.type === "template" && msg.companyId) {
            let camp = null;
            const campTag = String(msg.automationSource || "");
            if (campTag.startsWith("campaign:")) {
              const campId = campTag.slice("campaign:".length);
              camp = campId
                ? await prisma.campaign.findFirst({ where: { id: campId, companyId: msg.companyId } })
                : null;
            }
            if (!camp) {
              camp = await prisma.campaign.findFirst({
                where: { companyId: msg.companyId, status: { in: ["running", "completed"] } },
                orderBy: { updatedAt: "desc" },
              });
            }
            if (camp) {
              const data = {};
              if (next === "read") data.read = { increment: 1 };
              else if (next === "delivered") data.delivered = { increment: 1 };
              else if (next === "failed" && prev?.status !== "failed") {
                data.failed = { increment: 1 };
                if (prev?.status === "sent" || prev?.status === "delivered") {
                  data.sent = { decrement: 1 };
                }
              }
              if (Object.keys(data).length) {
                await prisma.campaign.update({ where: { id: camp.id }, data }).catch(() => {});
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("[wa] webhook processing error:", e.message);
  }
});

export default router;
