// routes/api.js
// REST API for the Nexwapi dashboard, backed by PostgreSQL via Prisma.
import express from "express";
import crypto from "crypto";
import multer from "multer";
import fs from "fs";
import path from "path";
import { prisma, toMessage, pickColor } from "../lib/prisma.js";
import {
  sendText, sendTemplate, sendTemplateWithParams, createTemplate, listTemplates,
  uploadMedia, sendMediaById, sendButtons,
} from "../lib/whatsappService.js";

const UPLOAD_DIR = path.resolve("uploads");
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 16 * 1024 * 1024 } }); // 16MB (WhatsApp limit)

// Map a mimetype to the WhatsApp media type.
function waMediaType(mime) {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  return "document";
}
import { WA_LIVE } from "../config/whatsapp.js";
import { hashPassword, comparePassword, signToken } from "../lib/auth.js";
import { runCampaign, resolveAudience } from "../lib/campaignRunner.js";
import { enrollContacts } from "../lib/dripRunner.js";
import { fireEvent } from "../lib/events.js";

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, company: u.company, role: u.role });

const router = express.Router();

// Build the inbox list (contact + last message + unread count).
async function buildConversations() {
  const contacts = await prisma.contact.findMany({
    include: { messages: { orderBy: { at: "desc" }, take: 50 }, assignedAgent: true },
  });
  return contacts
    .map((c) => {
      const last = c.messages[0];
      const unread = c.messages.filter((m) => m.direction === "in" && m.status !== "read").length;
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        color: c.color,
        tags: c.tags,
        lastMessage: last ? last.text : "No messages yet",
        lastAt: last ? last.at.getTime() : c.createdAt.getTime(),
        lastDirection: last ? last.direction : null,
        unread,
        chatStatus: c.chatStatus,
        labels: c.labels,
        assignedAgent: c.assignedAgent ? { id: c.assignedAgent.id, name: c.assignedAgent.name, color: c.assignedAgent.color } : null,
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

/* -------------------------------- Auth --------------------------------- */
// Create a new account (name, email, password) with a bcrypt-hashed password.
router.post("/auth/signup", async (req, res) => {
  const { name, email, password, company = "" } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "name, email and password required" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const user = await prisma.user.create({
      data: {
        name,
        email: String(email).toLowerCase().trim(),
        password: await hashPassword(password),
        company,
        role: (await prisma.user.count()) === 0 ? "Owner" : "Member",
      },
    });
    // Also add them as an agent for the shared inbox (best-effort).
    prisma.agent.create({ data: { name, email: user.email, role: user.role } }).catch(() => {});
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "An account with this email already exists" });
    throw e;
  }
});

// Log in with email + password (bcrypt), with a demo-account fallback.
router.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const em = String(email || "").toLowerCase().trim();

  const user = await prisma.user.findUnique({ where: { email: em } });
  if (user && (await comparePassword(password, user.password))) {
    return res.json({ token: signToken(user), user: publicUser(user) });
  }

  // Demo fallback (env creds) — lets the seeded demo account work without a stored hash.
  const demoEmail = String(process.env.DEMO_EMAIL || "admin@nexwapi.com").toLowerCase();
  if (em === demoEmail && password === (process.env.DEMO_PASSWORD || "admin123")) {
    const u = user || { id: "u_admin", name: "Aman", email: demoEmail, company: "Nexwapi", role: "Owner" };
    return res.json({ token: signToken(u), user: publicUser(u) });
  }

  return res.status(401).json({ error: "Invalid email or password" });
});

router.get("/me", async (req, res) => {
  if (req.user?.id) {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user) return res.json(publicUser(user));
  }
  const user = await prisma.user.findFirst();
  res.json(user ? publicUser(user) : { name: "Aman", email: process.env.DEMO_EMAIL, company: "Nexwapi", role: "Owner" });
});

/* ------------------------------ Contacts ------------------------------- */
router.get("/contacts", async (_req, res) => {
  const contacts = await prisma.contact.findMany({ orderBy: { createdAt: "desc" } });
  res.json(contacts.map((c) => ({ ...c, createdAt: c.createdAt.getTime() })));
});

router.post("/contacts", async (req, res) => {
  const { name, phone, tags = [] } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "name and phone required" });
  const cleanPhone = String(phone).replace(/[^\d]/g, "");
  const count = await prisma.contact.count();
  try {
    const contact = await prisma.contact.create({
      data: {
        name,
        phone: cleanPhone,
        tags: Array.isArray(tags) ? tags : String(tags).split(",").map((t) => t.trim()).filter(Boolean),
        color: pickColor(count),
      },
    });
    res.status(201).json({ ...contact, createdAt: contact.createdAt.getTime() });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Contact with this number already exists" });
    throw e;
  }
});

router.delete("/contacts/:id", async (req, res) => {
  try {
    await prisma.contact.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

// Bulk import contacts (from a parsed CSV). Skips invalid rows and duplicates.
router.post("/contacts/import", async (req, res) => {
  const { contacts } = req.body || {};
  if (!Array.isArray(contacts)) return res.status(400).json({ error: "contacts array required" });
  const start = await prisma.contact.count();
  let added = 0, skipped = 0;
  for (const c of contacts) {
    const phone = String(c.phone || "").replace(/[^\d]/g, "");
    if (!phone || !c.name) { skipped++; continue; }
    const tags = Array.isArray(c.tags)
      ? c.tags
      : String(c.tags || "").split(/[;|]/).map((t) => t.trim()).filter(Boolean);
    try {
      await prisma.contact.create({ data: { name: String(c.name).trim(), phone, tags, color: pickColor(start + added) } });
      added++;
    } catch {
      skipped++; // duplicate phone / invalid
    }
  }
  res.json({ added, skipped });
});

// Send a media file (image / document / video / audio) to a contact.
router.post("/conversations/:id/media", upload.single("file"), async (req, res) => {
  const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!contact) return res.sendStatus(404);
  if (!req.file) return res.status(400).json({ error: "file required" });

  const { originalname, mimetype, filename, path: tmpPath } = req.file;
  const storedName = filename + (path.extname(originalname) || "");
  fs.renameSync(tmpPath, path.join(UPLOAD_DIR, storedName));
  const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${storedName}`;
  const waType = waMediaType(mimetype);
  const caption = req.body?.caption || "";

  let waId = null;
  try {
    const mediaId = await uploadMedia(fs.readFileSync(path.join(UPLOAD_DIR, storedName)), mimetype, originalname);
    if (mediaId) {
      const r = await sendMediaById(contact.phone, waType, mediaId, { filename: originalname, caption });
      waId = r.messages?.[0]?.id || null;
    }
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  const msg = await prisma.message.create({
    data: { contactId: contact.id, waId, direction: "out", type: waType, text: caption || originalname, mediaUrl: publicUrl, filename: originalname, status: "sent" },
  });
  res.status(201).json(toMessage(msg));
});

// Update chat status (open | pending | resolved).
router.patch("/conversations/:id/status", async (req, res) => {
  const { status } = req.body || {};
  if (!["open", "pending", "resolved"].includes(status)) return res.status(400).json({ error: "invalid status" });
  try {
    const c = await prisma.contact.update({ where: { id: req.params.id }, data: { chatStatus: status } });
    fireEvent("chat.status", { name: c.name, phone: c.phone, status }).catch(() => {});

    // On resolve, optionally send a CSAT rating request.
    if (status === "resolved") {
      const s = await prisma.setting.findUnique({ where: { id: "default" } });
      if (s?.csatEnabled) {
        try {
          const r = await sendButtons(c.phone, s.csatMessage, [
            { id: "csat:Great", title: "😀 Great" },
            { id: "csat:Okay", title: "🙂 Okay" },
            { id: "csat:Poor", title: "😞 Poor" },
          ]);
          await prisma.message.create({ data: { contactId: c.id, waId: r.messages?.[0]?.id || null, direction: "out", type: "interactive", text: s.csatMessage, status: "sent" } });
        } catch (e) { console.error("[csat] send failed:", e.message); }
      }
    }
    res.json({ chatStatus: c.chatStatus });
  } catch {
    res.sendStatus(404);
  }
});

/* ---------------------------- Quick Replies ---------------------------- */
router.get("/quick-replies", async (_req, res) => {
  const items = await prisma.quickReply.findMany({ orderBy: { createdAt: "desc" } });
  res.json(items.map((q) => ({ ...q, createdAt: q.createdAt.getTime() })));
});

router.post("/quick-replies", async (req, res) => {
  const { title, text } = req.body || {};
  if (!title || !text) return res.status(400).json({ error: "title and text required" });
  const q = await prisma.quickReply.create({ data: { title, text } });
  res.status(201).json({ ...q, createdAt: q.createdAt.getTime() });
});

router.delete("/quick-replies/:id", async (req, res) => {
  try {
    await prisma.quickReply.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------------- Agents -------------------------------- */
router.get("/agents", async (_req, res) => {
  const agents = await prisma.agent.findMany({ orderBy: { createdAt: "asc" } });
  res.json(agents.map((a) => ({ ...a, createdAt: a.createdAt.getTime() })));
});

router.post("/agents", async (req, res) => {
  const { name, email, role = "Agent" } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  const colors = ["#25D366", "#128C7E", "#34B7F1", "#7C3AED", "#F59E0B", "#EF4444"];
  try {
    const count = await prisma.agent.count();
    const agent = await prisma.agent.create({ data: { name, email, role, color: colors[count % colors.length] } });
    res.status(201).json({ ...agent, createdAt: agent.createdAt.getTime() });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Agent with this email already exists" });
    throw e;
  }
});

router.delete("/agents/:id", async (req, res) => {
  try {
    await prisma.contact.updateMany({ where: { assignedAgentId: req.params.id }, data: { assignedAgentId: null } });
    await prisma.agent.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

// Assign / unassign a conversation (contact) to an agent.
router.patch("/conversations/:id/assign", async (req, res) => {
  const { agentId } = req.body || {};
  try {
    const contact = await prisma.contact.update({
      where: { id: req.params.id },
      data: { assignedAgentId: agentId || null },
      include: { assignedAgent: true },
    });
    res.json({
      assignedAgent: contact.assignedAgent
        ? { id: contact.assignedAgent.id, name: contact.assignedAgent.name, color: contact.assignedAgent.color }
        : null,
    });
  } catch {
    res.sendStatus(404);
  }
});

/* -------------------------- Contact notes ------------------------------ */
router.get("/conversations/:id/notes", async (req, res) => {
  const notes = await prisma.note.findMany({ where: { contactId: req.params.id }, orderBy: { createdAt: "desc" } });
  res.json(notes.map((n) => ({ ...n, createdAt: n.createdAt.getTime() })));
});

router.post("/conversations/:id/notes", async (req, res) => {
  const { text, author = "You" } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!contact) return res.sendStatus(404);
  const note = await prisma.note.create({ data: { contactId: req.params.id, text, author } });
  res.status(201).json({ ...note, createdAt: note.createdAt.getTime() });
});

router.delete("/notes/:id", async (req, res) => {
  try {
    await prisma.note.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

// Update a contact's custom fields (attributes).
router.patch("/conversations/:id/attributes", async (req, res) => {
  const { attributes } = req.body || {};
  try {
    const contact = await prisma.contact.update({ where: { id: req.params.id }, data: { attributes: attributes || {} } });
    res.json({ attributes: contact.attributes });
  } catch {
    res.sendStatus(404);
  }
});

/* --------------------------- Product catalog --------------------------- */
router.get("/products", async (_req, res) => {
  const products = await prisma.product.findMany({ orderBy: { createdAt: "desc" } });
  res.json(products.map((p) => ({ ...p, createdAt: p.createdAt.getTime() })));
});

router.post("/products", async (req, res) => {
  const { name, price = "", description = "", imageUrl = "" } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const product = await prisma.product.create({ data: { name, price, description, imageUrl } });
  res.status(201).json({ ...product, createdAt: product.createdAt.getTime() });
});

router.delete("/products/:id", async (req, res) => {
  try {
    await prisma.product.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------------ Segments ------------------------------- */
router.get("/segments", async (_req, res) => {
  const segments = await prisma.segment.findMany({ orderBy: { createdAt: "desc" } });
  const withCounts = await Promise.all(
    segments.map(async (s) => ({
      ...s,
      createdAt: s.createdAt.getTime(),
      count: await prisma.contact.count({ where: await resolveAudience(`segment: ${s.name}`) }),
    }))
  );
  res.json(withCounts);
});

router.post("/segments", async (req, res) => {
  const { name, tags = [], match = "any" } = req.body || {};
  if (!name || !Array.isArray(tags) || !tags.length) return res.status(400).json({ error: "name and tags required" });
  const seg = await prisma.segment.create({ data: { name, tags, match } });
  res.status(201).json({ ...seg, createdAt: seg.createdAt.getTime() });
});

router.delete("/segments/:id", async (req, res) => {
  try {
    await prisma.segment.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------------- Labels -------------------------------- */
router.get("/labels", async (_req, res) => {
  const labels = await prisma.label.findMany({ orderBy: { createdAt: "asc" } });
  res.json(labels.map((l) => ({ ...l, createdAt: l.createdAt.getTime() })));
});

router.post("/labels", async (req, res) => {
  const { name, color = "#25D366" } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const label = await prisma.label.create({ data: { name, color } });
  res.status(201).json({ ...label, createdAt: label.createdAt.getTime() });
});

router.delete("/labels/:id", async (req, res) => {
  try {
    await prisma.label.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

// Set the labels on a conversation (contact).
router.patch("/conversations/:id/labels", async (req, res) => {
  const { labels } = req.body || {};
  try {
    const c = await prisma.contact.update({ where: { id: req.params.id }, data: { labels: Array.isArray(labels) ? labels : [] } });
    res.json({ labels: c.labels });
  } catch {
    res.sendStatus(404);
  }
});

/* ----------------------------- Inbox / chat ---------------------------- */
router.get("/conversations", async (_req, res) => res.json(await buildConversations()));

// Full-text search across all message content — returns matching chats + snippet.
router.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  const messages = await prisma.message.findMany({
    where: { text: { contains: q, mode: "insensitive" } },
    include: { contact: true },
    orderBy: { at: "desc" },
    take: 40,
  });
  const seen = new Set();
  const results = [];
  for (const m of messages) {
    if (seen.has(m.contactId)) continue;
    seen.add(m.contactId);
    results.push({ id: m.contact.id, name: m.contact.name, phone: m.contact.phone, color: m.contact.color, snippet: m.text, at: m.at.getTime() });
  }
  res.json(results);
});

router.get("/conversations/:id/messages", async (req, res) => {
  const contact = await prisma.contact.findUnique({ where: { id: req.params.id }, include: { assignedAgent: true } });
  if (!contact) return res.sendStatus(404);
  // Mark inbound as read.
  await prisma.message.updateMany({
    where: { contactId: contact.id, direction: "in", status: { not: "read" } },
    data: { status: "read" },
  });
  const messages = await prisma.message.findMany({
    where: { contactId: contact.id },
    orderBy: { at: "asc" },
  });
  res.json({
    contact: {
      ...contact,
      createdAt: contact.createdAt.getTime(),
      assignedAgent: contact.assignedAgent
        ? { id: contact.assignedAgent.id, name: contact.assignedAgent.name, color: contact.assignedAgent.color }
        : null,
    },
    messages: messages.map(toMessage),
  });
});

router.post("/conversations/:id/messages", async (req, res) => {
  const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!contact) return res.sendStatus(404);
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });

  let waId = null;
  try {
    const result = await sendText(contact.phone, text);
    waId = result.messages?.[0]?.id || null;
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  const msg = await prisma.message.create({
    data: { contactId: contact.id, waId, direction: "out", type: "text", text, status: "sent" },
  });
  res.status(201).json(toMessage(msg));
});

// Send an approved template to a contact (business-initiated — works outside the 24h window).
router.post("/conversations/:id/send-template", async (req, res) => {
  const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!contact) return res.sendStatus(404);
  const { template, params = [], language = "en" } = req.body || {};
  if (!template) return res.status(400).json({ error: "template required" });

  let waId = null;
  try {
    const result = params.length
      ? await sendTemplateWithParams(contact.phone, template, params, language)
      : await sendTemplate(contact.phone, template, language);
    waId = result.messages?.[0]?.id || null;
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  // Render the template body with params for a readable inbox entry.
  const tpl = await prisma.template.findUnique({ where: { name: template } });
  let text = tpl?.body || `[Template: ${template}]`;
  params.forEach((p, i) => { text = text.replace(`{{${i + 1}}}`, p); });

  const msg = await prisma.message.create({
    data: { contactId: contact.id, waId, direction: "out", type: "template", text, status: "sent" },
  });
  res.status(201).json(toMessage(msg));
});

/* ------------------------------ Templates ------------------------------ */
router.get("/templates", async (_req, res) => {
  const templates = await prisma.template.findMany({ orderBy: { createdAt: "desc" } });
  res.json(templates.map((t) => ({ ...t, createdAt: t.createdAt.getTime() })));
});

router.post("/templates", async (req, res) => {
  const { name, category = "Utility", language = "en", body } = req.body || {};
  if (!name || !body) return res.status(400).json({ error: "name and body required" });
  const cleanName = String(name).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

  // Submit to Meta for approval (falls back to local-only if not live / on error).
  let status = "pending";
  let metaError = null;
  if (WA_LIVE) {
    try {
      const r = await createTemplate({ name: cleanName, category, language, body });
      status = (r.status || "pending").toLowerCase();
    } catch (e) {
      metaError = e.message;
    }
  }

  try {
    const tpl = await prisma.template.create({
      data: { name: cleanName, category, language, body, status },
    });
    res.status(201).json({ ...tpl, createdAt: tpl.createdAt.getTime(), metaError });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Template name already exists" });
    throw e;
  }
});

// Pull the latest template statuses from Meta and reconcile the local list.
router.post("/templates/sync", async (_req, res) => {
  if (!WA_LIVE) return res.status(400).json({ error: "Not in live mode" });
  try {
    const metaTemplates = await listTemplates();
    for (const mt of metaTemplates) {
      const status = (mt.status || "").toLowerCase();
      const existing = await prisma.template.findUnique({ where: { name: mt.name } });
      if (existing) {
        await prisma.template.update({ where: { name: mt.name }, data: { status, category: cap(mt.category), language: mt.language } });
      } else {
        await prisma.template.create({ data: { name: mt.name, status, category: cap(mt.category), language: mt.language, body: "(synced from Meta — edit in WhatsApp Manager)" } });
      }
    }
    const all = await prisma.template.findMany({ orderBy: { createdAt: "desc" } });
    res.json(all.map((t) => ({ ...t, createdAt: t.createdAt.getTime() })));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ------------------------------ Campaigns ------------------------------ */
router.get("/campaigns", async (_req, res) => {
  const campaigns = await prisma.campaign.findMany({ orderBy: { createdAt: "desc" } });
  res.json(campaigns.map((c) => ({ ...c, createdAt: c.createdAt.getTime(), scheduledAt: c.scheduledAt?.getTime() || null })));
});

router.post("/campaigns", async (req, res) => {
  const { name, template, audience = "All contacts", scheduledAt } = req.body || {};
  if (!name || !template) return res.status(400).json({ error: "name and template required" });
  const recipients = await prisma.contact.count({ where: await resolveAudience(audience) });
  const campaign = await prisma.campaign.create({
    data: {
      name, template, audience, recipients, status: "scheduled",
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    },
  });
  res.status(201).json({ ...campaign, createdAt: campaign.createdAt.getTime(), scheduledAt: campaign.scheduledAt?.getTime() || null });
});

// Broadcast engine — send now (the scheduler auto-runs scheduled ones).
router.post("/campaigns/:id/send", async (req, res) => {
  const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!campaign) return res.sendStatus(404);
  if (campaign.status === "running") return res.status(409).json({ error: "Campaign already running" });
  res.json({ ok: true, status: "running" });
  runCampaign(campaign.id).catch((e) => console.error("[campaign] run error:", e.message));
});

/* ----------------------------- Drip campaigns -------------------------- */
router.get("/drips", async (_req, res) => {
  const drips = await prisma.drip.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { enrollments: true } } } });
  res.json(drips.map((d) => ({ ...d, createdAt: d.createdAt.getTime(), enrolled: d._count.enrollments })));
});

router.post("/drips", async (req, res) => {
  const { name, steps } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const drip = await prisma.drip.create({
    data: { name, steps: Array.isArray(steps) ? steps : [{ template: "", delayHours: 0 }] },
  });
  res.status(201).json({ ...drip, createdAt: drip.createdAt.getTime(), enrolled: 0 });
});

router.patch("/drips/:id", async (req, res) => {
  const { name, enabled, steps } = req.body || {};
  try {
    const drip = await prisma.drip.update({
      where: { id: req.params.id },
      data: { ...(name !== undefined && { name }), ...(enabled !== undefined && { enabled }), ...(steps !== undefined && { steps }) },
    });
    res.json({ ...drip, createdAt: drip.createdAt.getTime() });
  } catch {
    res.sendStatus(404);
  }
});

router.delete("/drips/:id", async (req, res) => {
  try {
    await prisma.drip.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

// Enroll an audience into a drip.
router.post("/drips/:id/enroll", async (req, res) => {
  const { audience = "All contacts" } = req.body || {};
  const contacts = await prisma.contact.findMany({ where: await resolveAudience(audience) });
  const enrolled = await enrollContacts(req.params.id, contacts);
  res.json({ enrolled });
});

/* ----------------------------- Automations ----------------------------- */
router.get("/automations", async (_req, res) => {
  const items = await prisma.automation.findMany({ orderBy: { createdAt: "desc" } });
  res.json(items.map((a) => ({ ...a, createdAt: a.createdAt.getTime() })));
});

router.post("/automations", async (req, res) => {
  const { name, keyword = "", matchType = "contains", reply } = req.body || {};
  if (!name || !reply) return res.status(400).json({ error: "name and reply required" });
  const a = await prisma.automation.create({ data: { name, keyword, matchType, reply } });
  res.status(201).json({ ...a, createdAt: a.createdAt.getTime() });
});

router.patch("/automations/:id", async (req, res) => {
  const { enabled, name, keyword, matchType, reply } = req.body || {};
  try {
    const a = await prisma.automation.update({
      where: { id: req.params.id },
      data: {
        ...(enabled !== undefined && { enabled }),
        ...(name !== undefined && { name }),
        ...(keyword !== undefined && { keyword }),
        ...(matchType !== undefined && { matchType }),
        ...(reply !== undefined && { reply }),
      },
    });
    res.json({ ...a, createdAt: a.createdAt.getTime() });
  } catch {
    res.sendStatus(404);
  }
});

router.delete("/automations/:id", async (req, res) => {
  try {
    await prisma.automation.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------- Chatbot Flows ------------------------------- */
router.get("/flows", async (_req, res) => {
  const flows = await prisma.flow.findMany({ orderBy: { createdAt: "desc" } });
  res.json(flows.map((f) => ({ ...f, createdAt: f.createdAt.getTime() })));
});

router.post("/flows", async (req, res) => {
  const { name, triggerType = "keyword", trigger = "", steps } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const defaultSteps = [
    { id: "start", message: "Hi! 👋 How can we help you today?", buttons: [{ title: "Pricing", next: "pricing" }, { title: "Talk to agent", next: "agent" }] },
    { id: "pricing", message: "See all our plans here: https://nexwapi.com/pricing", buttons: [] },
    { id: "agent", message: "Sure! One of our agents will reach out to you shortly. 🙌", buttons: [] },
  ];
  const flow = await prisma.flow.create({
    data: { name, triggerType, trigger, steps: Array.isArray(steps) && steps.length ? steps : defaultSteps },
  });
  res.status(201).json({ ...flow, createdAt: flow.createdAt.getTime() });
});

router.patch("/flows/:id", async (req, res) => {
  const { name, triggerType, trigger, enabled, steps } = req.body || {};
  try {
    const flow = await prisma.flow.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(triggerType !== undefined && { triggerType }),
        ...(trigger !== undefined && { trigger }),
        ...(enabled !== undefined && { enabled }),
        ...(steps !== undefined && { steps }),
      },
    });
    res.json({ ...flow, createdAt: flow.createdAt.getTime() });
  } catch {
    res.sendStatus(404);
  }
});

router.delete("/flows/:id", async (req, res) => {
  try {
    await prisma.contact.updateMany({ where: { activeFlowId: req.params.id }, data: { activeFlowId: null, activeFlowStep: null } });
    await prisma.flow.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------------ Settings ------------------------------- */
router.get("/settings", async (_req, res) => {
  const s = await prisma.setting.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  res.json(s);
});

router.patch("/settings", async (req, res) => {
  const { awayEnabled, awayMessage, hoursStart, hoursEnd, days, businessName, autoAssign, webhookUrl, csatEnabled, csatMessage } = req.body || {};
  const data = {
    ...(awayEnabled !== undefined && { awayEnabled }),
    ...(awayMessage !== undefined && { awayMessage }),
    ...(hoursStart !== undefined && { hoursStart: Number(hoursStart) }),
    ...(hoursEnd !== undefined && { hoursEnd: Number(hoursEnd) }),
    ...(days !== undefined && { days }),
    ...(businessName !== undefined && { businessName }),
    ...(autoAssign !== undefined && { autoAssign }),
    ...(webhookUrl !== undefined && { webhookUrl }),
    ...(csatEnabled !== undefined && { csatEnabled }),
    ...(csatMessage !== undefined && { csatMessage }),
  };
  const s = await prisma.setting.upsert({ where: { id: "default" }, update: data, create: { id: "default", ...data } });
  res.json(s);
});

/* ------------------------- Developer API keys -------------------------- */
router.get("/api-keys", async (_req, res) => {
  const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: "desc" } });
  res.json(keys.map((k) => ({ ...k, createdAt: k.createdAt.getTime(), lastUsedAt: k.lastUsedAt?.getTime() || null })));
});

router.post("/api-keys", async (req, res) => {
  const { name = "Default key" } = req.body || {};
  const key = "nex_" + crypto.randomBytes(24).toString("hex");
  const k = await prisma.apiKey.create({ data: { name, key } });
  res.status(201).json({ ...k, createdAt: k.createdAt.getTime(), lastUsedAt: null });
});

router.delete("/api-keys/:id", async (req, res) => {
  try {
    await prisma.apiKey.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

// Public send API (for Zapier / Shopify / custom integrations). Auth via x-api-key.
router.post("/v1/messages", async (req, res) => {
  const key = req.headers["x-api-key"];
  if (!key) return res.status(401).json({ error: "Missing x-api-key header" });
  const apiKey = await prisma.apiKey.findUnique({ where: { key } });
  if (!apiKey) return res.status(401).json({ error: "Invalid API key" });
  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  const { to, text, template, params, language = "en" } = req.body || {};
  if (!to) return res.status(400).json({ error: "to (phone number) required" });
  try {
    let result;
    if (template) {
      result = params?.length
        ? await sendTemplateWithParams(to, template, params, language)
        : await sendTemplate(to, template, language);
    } else if (text) {
      result = await sendText(to, text);
    } else {
      return res.status(400).json({ error: "text or template required" });
    }
    // Log the outbound message if the recipient is a known contact.
    const contact = await prisma.contact.findUnique({ where: { phone: String(to).replace(/[^\d]/g, "") } });
    if (contact) {
      await prisma.message.create({
        data: { contactId: contact.id, waId: result.messages?.[0]?.id || null, direction: "out", type: template ? "template" : "text", text: text || `[Template: ${template}]`, status: "sent" },
      });
    }
    res.json({ ok: true, messageId: result.messages?.[0]?.id || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* -------------------------- Reports (deep) ----------------------------- */
router.get("/reports", async (_req, res) => {
  const agents = await prisma.agent.findMany({ orderBy: { createdAt: "asc" } });
  const agentStats = await Promise.all(
    agents.map(async (a) => ({
      name: a.name,
      color: a.color,
      assigned: await prisma.contact.count({ where: { assignedAgentId: a.id } }),
      resolved: await prisma.contact.count({ where: { assignedAgentId: a.id, chatStatus: "resolved" } }),
    }))
  );

  const [open, pending, resolved, contactsTotal, inbound, outbound] = await Promise.all([
    prisma.contact.count({ where: { chatStatus: "open" } }),
    prisma.contact.count({ where: { chatStatus: "pending" } }),
    prisma.contact.count({ where: { chatStatus: "resolved" } }),
    prisma.contact.count(),
    prisma.message.count({ where: { direction: "in" } }),
    prisma.message.count({ where: { direction: "out" } }),
  ]);

  // Top tags
  const contacts = await prisma.contact.findMany({ select: { tags: true } });
  const tagMap = {};
  contacts.forEach((c) => (c.tags || []).forEach((t) => (tagMap[t] = (tagMap[t] || 0) + 1)));
  const topTags = Object.entries(tagMap).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 8);

  const campaigns = await prisma.campaign.findMany({ orderBy: { createdAt: "desc" }, take: 6 });

  res.json({
    totals: {
      contacts: contactsTotal,
      messages: inbound + outbound,
      chats: open + pending + resolved,
      resolvedRate: open + pending + resolved ? Math.round((resolved / (open + pending + resolved)) * 100) : 0,
    },
    agents: agentStats,
    statusBreakdown: { open, pending, resolved },
    messageVolume: { inbound, outbound },
    topTags,
    campaigns: campaigns.map((c) => ({ name: c.name, sent: c.sent, delivered: c.delivered, read: c.read, replied: c.replied })),
  });
});

/* ------------------------------ Analytics ------------------------------ */
router.get("/analytics", async (_req, res) => {
  const [contacts, agg, conversations] = await Promise.all([
    prisma.contact.count(),
    prisma.campaign.aggregate({ _sum: { sent: true, delivered: true, read: true, replied: true }, _count: true }),
    buildConversations(),
  ]);

  const sent = agg._sum.sent || 0;
  const delivered = agg._sum.delivered || 0;
  const read = agg._sum.read || 0;
  const openChats = conversations.filter((c) => c.unread > 0).length;

  const series = [
    { day: "Mon", sent: 620, delivered: 600, read: 480 },
    { day: "Tue", sent: 810, delivered: 790, read: 610 },
    { day: "Wed", sent: 540, delivered: 520, read: 410 },
    { day: "Thu", sent: 980, delivered: 940, read: 760 },
    { day: "Fri", sent: 1200, delivered: 1160, read: 905 },
    { day: "Sat", sent: 760, delivered: 740, read: 590 },
    { day: "Sun", sent: 430, delivered: 420, read: 330 },
  ];

  res.json({
    kpis: {
      contacts,
      sent,
      deliveredRate: sent ? Math.round((delivered / sent) * 100) : 0,
      readRate: sent ? Math.round((read / sent) * 100) : 0,
      replied: agg._sum.replied || 0,
      openChats,
      campaigns: agg._count || 0,
    },
    series,
  });
});

export default router;
