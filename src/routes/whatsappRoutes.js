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
import { sendText, sendButtons, fetchInboundMedia } from "../lib/whatsappService.js";
import { fireEvent } from "../lib/events.js";

const UPLOAD_DIR = path.resolve("uploads");
const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf", "video/mp4": ".mp4", "audio/ogg": ".ogg", "audio/mpeg": ".mp3" };

// Download an inbound media file and return a servable local URL.
async function saveInboundMedia(mediaId, hostUrl) {
  try {
    const media = await fetchInboundMedia(mediaId);
    if (!media) return null;
    const name = `in_${mediaId}${EXT[media.mimetype] || ""}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), media.buffer);
    return `${hostUrl}/uploads/${name}`;
  } catch (e) {
    console.error("[wa] inbound media download failed:", e.message);
    return null;
  }
}

// Pick the first enabled automation whose rule matches the inbound text.
async function findAutoReply(text) {
  const autos = await prisma.automation.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" } });
  const lc = (text || "").trim().toLowerCase();
  return autos.find((a) => {
    if (a.matchType === "any") return true;
    if (!a.keyword) return false;
    const k = a.keyword.trim().toLowerCase();
    return a.matchType === "exact" ? lc === k : lc.includes(k);
  });
}

// Round-robin: assign an unassigned chat to the agent with the fewest open chats.
async function autoAssignIfNeeded(contact) {
  if (contact.assignedAgentId) return contact.assignedAgentId;
  const s = await prisma.setting.findUnique({ where: { id: "default" } });
  if (!s?.autoAssign) return null;
  const agents = await prisma.agent.findMany();
  if (!agents.length) return null;
  const counts = await Promise.all(
    agents.map((a) => prisma.contact.count({ where: { assignedAgentId: a.id } }))
  );
  const idx = counts.indexOf(Math.min(...counts));
  const agentId = agents[idx].id;
  await prisma.contact.update({ where: { id: contact.id }, data: { assignedAgentId: agentId } });
  console.log("[wa] auto-assigned", contact.phone, "->", agents[idx].name);
  return agentId;
}

// Send an away message when outside business hours and nothing else replied
// (throttled to at most one per hour per contact).
async function maybeAway(contact) {
  const s = await prisma.setting.findUnique({ where: { id: "default" } });
  if (!s?.awayEnabled) return;
  const now = new Date();
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getDay()];
  const hour = now.getHours();
  const open = s.days.includes(day) && hour >= s.hoursStart && hour < s.hoursEnd;
  if (open) return; // agents available
  const recentOut = await prisma.message.findFirst({
    where: { contactId: contact.id, direction: "out", at: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  if (recentOut) return; // don't spam
  try {
    const r = await sendText(contact.phone, s.awayMessage);
    await prisma.message.create({
      data: { waId: r.messages?.[0]?.id || null, contactId: contact.id, direction: "out", type: "text", text: s.awayMessage, status: "sent" },
    });
    console.log("[wa] away message sent to", contact.phone);
  } catch (e) {
    console.error("[wa] away failed:", e.message);
  }
}

/* --------------------------- Chatbot flow engine --------------------------- */
// Send a flow step (text, or interactive buttons) and update the contact's state.
async function sendStep(contact, flow, step) {
  // API-call node: hit an external URL, save part of the response, then continue.
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
    if (nextStep) return sendStep(contact, flow, nextStep);
    await prisma.contact.update({ where: { id: contact.id }, data: { activeFlowId: null, activeFlowStep: null } });
    return;
  }

  const buttons = (step.buttons || []).filter((b) => b.title && b.next);
  let r;
  if (buttons.length) {
    r = await sendButtons(contact.phone, step.message, buttons.map((b) => ({ id: `next:${b.next}`, title: b.title })));
  } else {
    r = await sendText(contact.phone, step.message);
  }
  await prisma.message.create({
    data: { waId: r.messages?.[0]?.id || null, contactId: contact.id, direction: "out", type: buttons.length ? "interactive" : "text", text: step.message, status: "sent" },
  });
  // Stay in the flow if this step offers buttons, captures a reply, or branches on conditions.
  const waiting = buttons.length > 0 || Boolean(step.capture?.field) || (step.conditions?.length > 0);
  await prisma.contact.update({
    where: { id: contact.id },
    data: waiting ? { activeFlowId: flow.id, activeFlowStep: step.id } : { activeFlowId: null, activeFlowStep: null },
  });
}

// Returns true if a chatbot flow handled this message.
async function runChatbot(contact, m, text) {
  const btnId = m.interactive?.button_reply?.id; // "next:<stepId>"
  const lc = (text || "").trim().toLowerCase();

  // 1) Advance an in-progress flow.
  if (contact.activeFlowId) {
    const flow = await prisma.flow.findUnique({ where: { id: contact.activeFlowId } });
    if (flow?.enabled && Array.isArray(flow.steps)) {
      const current = flow.steps.find((s) => s.id === contact.activeFlowStep);
      let nextId = btnId?.startsWith("next:") ? btnId.slice(5) : null;
      if (!nextId && current) {
        const btn = (current.buttons || []).find((b) => b.title?.toLowerCase() === lc);
        if (btn) nextId = btn.next;
      }
      // Capture step: save the user's reply into a custom field, then advance.
      if (!nextId && current?.capture?.field) {
        const attrs = { ...(contact.attributes || {}), [current.capture.field]: text };
        await prisma.contact.update({ where: { id: contact.id }, data: { attributes: attrs } });
        contact.attributes = attrs;
        nextId = current.capture.next;
        console.log(`[wa] captured "${current.capture.field}" =`, text);
      }
      // Conditional branch: route by keyword in the reply, else a default step.
      if (!nextId && current?.conditions?.length) {
        const cond = current.conditions.find((c) => c.match && lc.includes(c.match.toLowerCase()));
        nextId = cond?.next || current.defaultNext || null;
      }
      const next = nextId ? flow.steps.find((s) => s.id === nextId) : null;
      if (next) { await sendStep(contact, flow, next); return true; }
      // Unrecognised reply → drop out of the flow and fall through.
      await prisma.contact.update({ where: { id: contact.id }, data: { activeFlowId: null, activeFlowStep: null } });
    }
  }

  // 2) Start a flow whose trigger matches.
  const flows = await prisma.flow.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" } });
  for (const flow of flows) {
    if (!Array.isArray(flow.steps) || !flow.steps.length) continue;
    const match = flow.triggerType === "any" || (flow.trigger && lc.includes(flow.trigger.toLowerCase()));
    if (match) { await sendStep(contact, flow, flow.steps[0]); return true; }
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
        const profileName = value?.contacts?.[0]?.profile?.name;

        // Inbound messages from users
        for (const m of value.messages || []) {
          const count = await prisma.contact.count();
          const contact = await prisma.contact.upsert({
            where: { phone: m.from },
            update: {},
            create: {
              name: profileName || `+${m.from}`,
              phone: m.from,
              tags: ["inbound"],
              color: pickColor(count),
            },
          });
          const bodyText = textOf(m);

          // Download inbound media (image / document / video / audio) if present.
          let mediaUrl = null;
          let filename = null;
          const mediaObj = m.image || m.document || m.video || m.audio;
          if (mediaObj?.id) {
            const hostUrl = `${req.protocol}://${req.get("host")}`;
            mediaUrl = await saveInboundMedia(mediaObj.id, hostUrl);
            filename = m.document?.filename || null;
          }

          await prisma.message.create({
            data: {
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

          // Fire outgoing webhook event (Zapier/Make/custom integrations).
          fireEvent("message.received", { from: m.from, name: contact.name, text: bodyText, type: m.type }).catch(() => {});

          // Auto-assign the chat to an agent (round-robin) if enabled.
          await autoAssignIfNeeded(contact).catch(() => {});

          // 0) CSAT rating reply — save the rating and thank the user.
          const btnId0 = m.interactive?.button_reply?.id;
          if (btnId0?.startsWith("csat:")) {
            const rating = btnId0.slice(5);
            const attrs = { ...(contact.attributes || {}), csat_rating: rating, csat_at: new Date().toISOString() };
            await prisma.contact.update({ where: { id: contact.id }, data: { attributes: attrs } });
            try {
              const r = await sendText(contact.phone, "🙏 Thank you for your feedback!");
              await prisma.message.create({ data: { waId: r.messages?.[0]?.id || null, contactId: contact.id, direction: "out", type: "text", text: "🙏 Thank you for your feedback!", status: "sent" } });
            } catch {}
            console.log("[csat] rating from", contact.phone, "=", rating);
            continue;
          }

          // 1) Chatbot flows take priority (start/advance a flow).
          let handled = false;
          try {
            handled = await runChatbot(contact, m, bodyText);
            if (handled) console.log("[wa] chatbot handled", m.from);
          } catch (e) {
            console.error("[wa] chatbot error:", e.message);
          }
          if (handled) continue;

          // 2) Auto-reply (free text is allowed within 24h of the user's message).
          const auto = await findAutoReply(bodyText);
          if (auto) {
            try {
              const r = await sendText(m.from, auto.reply);
              await prisma.message.create({
                data: {
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
            // 3) Nothing matched — send an away message if off-hours.
            await maybeAway(contact);
          }
        }

        // Delivery / read receipts for messages we sent
        for (const s of value.statuses || []) {
          await prisma.message.updateMany({ where: { waId: s.id }, data: { status: s.status } });
          console.log("[wa] status", s.id, "->", s.status);
        }
      }
    }
  } catch (e) {
    console.error("[wa] webhook processing error:", e.message);
  }
});

export default router;
