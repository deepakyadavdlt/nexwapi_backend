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
import { sendText, sendButtons, fetchInboundMedia, getCompanyCreds } from "../lib/whatsappService.js";
import { spendCredits, refundCredits, getPlatformPricing } from "../lib/wallet.js";
import { fireEvent } from "../lib/events.js";

const UPLOAD_DIR = path.resolve("uploads");
const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf", "video/mp4": ".mp4", "audio/ogg": ".ogg", "audio/mpeg": ".mp3" };

async function outboundChargeAndSend(companyId, to, sendFn, meta = {}) {
  const pricing = await getPlatformPricing();
  const creditsNeeded = pricing.creditPerOutbound || 1;
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  let debited = false;
  try {
    if (!company?.freeAccess) {
      await spendCredits(companyId, creditsNeeded, "message_send", { to, ...meta });
      debited = true;
    }
    const creds = await getCompanyCreds(companyId);
    return await sendFn(creds);
  } catch (e) {
    if (debited) {
      await refundCredits(companyId, creditsNeeded, "message_refund", { to, reason: e.message, ...meta }).catch(() => {});
    }
    throw e;
  }
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

/** Resolve tenant companyId from webhook metadata.phone_number_id (or env fallback). */
async function resolveCompanyId(value) {
  const phoneNumberId = value?.metadata?.phone_number_id || WA.phoneNumberId;
  if (phoneNumberId) {
    const acct = await prisma.whatsAppAccount.findFirst({
      where: { phoneNumberId: String(phoneNumberId), isConnected: true },
    });
    if (acct?.companyId) return acct.companyId;
  }
  // Demo / single-tenant fallback: first active company
  const co = await prisma.company.findFirst({
    where: { status: { in: ["TRIAL", "ACTIVE"] } },
    orderBy: { createdAt: "asc" },
  });
  return co?.id || null;
}

async function findAutoReply(text, companyId) {
  const autos = await prisma.automation.findMany({
    where: { enabled: true, ...(companyId ? { companyId } : {}) },
    orderBy: { createdAt: "asc" },
  });
  const lc = (text || "").trim().toLowerCase();
  return autos.find((a) => {
    if (a.matchType === "any") return true;
    if (!a.keyword) return false;
    const k = a.keyword.trim().toLowerCase();
    return a.matchType === "exact" ? lc === k : lc.includes(k);
  });
}

async function autoAssignIfNeeded(contact, companyId) {
  if (contact.assignedAgentId) return contact.assignedAgentId;
  const s = await prisma.setting.findUnique({ where: { companyId } }).catch(() => null);
  if (!s?.autoAssign) return null;
  const agents = await prisma.agent.findMany({ where: { companyId } });
  if (!agents.length) return null;
  const counts = await Promise.all(
    agents.map((a) => prisma.contact.count({ where: { assignedAgentId: a.id, companyId } }))
  );
  const idx = counts.indexOf(Math.min(...counts));
  const agentId = agents[idx].id;
  await prisma.contact.update({ where: { id: contact.id }, data: { assignedAgentId: agentId } });
  console.log("[wa] auto-assigned", contact.phone, "->", agents[idx].name);
  return agentId;
}

async function maybeAway(contact, companyId) {
  const s = await prisma.setting.findUnique({ where: { companyId } }).catch(() => null);
  if (!s?.awayEnabled) return;
  const now = new Date();
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getDay()];
  const hour = now.getHours();
  const open = s.days.includes(day) && hour >= s.hoursStart && hour < s.hoursEnd;
  if (open) return;
  const recentOut = await prisma.message.findFirst({
    where: { contactId: contact.id, direction: "out", at: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  if (recentOut) return;
  try {
    const r = await outboundChargeAndSend(companyId, contact.phone, (creds) =>
      sendText(contact.phone, s.awayMessage, creds)
    , { channel: "away" });
    await prisma.message.create({
      data: {
        companyId,
        waId: r.messages?.[0]?.id || null,
        contactId: contact.id,
        direction: "out",
        type: "text",
        text: s.awayMessage,
        status: "sent",
      },
    });
    console.log("[wa] away message sent to", contact.phone);
  } catch (e) {
    console.error("[wa] away failed:", e.message);
  }
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
    },
  });
  const waiting = buttons.length > 0 || Boolean(step.capture?.field) || (step.conditions?.length > 0);
  await prisma.contact.update({
    where: { id: contact.id },
    data: waiting ? { activeFlowId: flow.id, activeFlowStep: step.id } : { activeFlowId: null, activeFlowStep: null },
  });
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
    }
  }

  const flows = await prisma.flow.findMany({ where: { enabled: true, companyId: cid }, orderBy: { createdAt: "asc" } });
  for (const flow of flows) {
    if (!Array.isArray(flow.steps) || !flow.steps.length) continue;
    const match = flow.triggerType === "any" || (flow.trigger && lc.includes(flow.trigger.toLowerCase()));
    if (match) { await sendStep(contact, flow, flow.steps[0], cid); return true; }
  }
  return false;
}

const router = express.Router();

// Extract readable text from any inbound message type.
function textOf(m) {
  switch (m.type) {
    case "text": return m.text?.body || "";
    case "button": return m.button?.text || "";
    case "interactive":
      return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "";
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
      for (const change of entry?.changes || []) {
        const value = change?.value;
        if (!value) continue;
        const companyId = await resolveCompanyId(value);
        if (!companyId) {
          console.warn("[wa] no company for phone_number_id", value?.metadata?.phone_number_id);
          continue;
        }
        // Mark webhook activity
        await prisma.whatsAppAccount.updateMany({
          where: { companyId, phoneNumberId: String(value?.metadata?.phone_number_id || "") },
          data: { lastWebhookAt: new Date(), webhookStatus: "connected" },
        }).catch(() => {});

        const profileName = value?.contacts?.[0]?.profile?.name;

        for (const m of value.messages || []) {
          const count = await prisma.contact.count({ where: { companyId } });
          const contact = await prisma.contact.upsert({
            where: { companyId_phone: { companyId, phone: m.from } },
            update: {},
            create: {
              companyId,
              name: profileName || `+${m.from}`,
              phone: m.from,
              tags: ["inbound"],
              color: pickColor(count),
            },
          });
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
          console.log("[wa] incoming from", m.from, ":", bodyText);

          fireEvent("message.received", { from: m.from, name: contact.name, text: bodyText, type: m.type }).catch(() => {});
          await autoAssignIfNeeded(contact, companyId).catch(() => {});

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

          let handled = false;
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
                },
              });
              console.log(`[wa] auto-replied (${auto.name}) to`, m.from);
            } catch (e) {
              console.error("[wa] auto-reply failed:", e.message);
            }
          } else {
            await maybeAway(contact, companyId);
          }
        }

        for (const s of value.statuses || []) {
          await prisma.message.updateMany({ where: { waId: s.id, companyId }, data: { status: s.status } });
          console.log("[wa] status", s.id, "->", s.status);
        }
      }
    }
  } catch (e) {
    console.error("[wa] webhook processing error:", e.message);
  }
});

export default router;
