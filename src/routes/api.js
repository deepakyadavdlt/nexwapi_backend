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
  uploadMedia, sendMediaById, sendButtons, createCarouselTemplate, getCompanyCreds,
} from "../lib/whatsappService.js";
import { spendCredits, refundCredits, creditWallet, creditsFromPaise, getPlatformPricing, applyPlanCredits } from "../lib/wallet.js";
import {
  metaSignupConfig, exchangeCodeForToken, exchangeForLongLivedToken,
  fetchPhoneNumbers, subscribeWabaWebhooks, fetchPhoneDetails, fetchSharedWabas,
} from "../lib/metaOAuth.js";

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
import { hashPassword, comparePassword, signToken, requireAuth } from "../lib/auth.js";
import {
  attachCompany, companyIdOf, tenantWhere, publicCompanyUser, uniqueSlug,
  requireNotSuspended, requireFeature, isSuperAdmin,
} from "../lib/tenant.js";
import { PLAN_CATALOG, normalizePlan, hasFeature } from "../lib/plans.js";
import { RAZORPAY_ENABLED, RAZORPAY_KEY_ID, PLANS, razorpay, verifySignature, verifyWebhook } from "../lib/razorpay.js";
import { runCampaign, resolveAudience } from "../lib/campaignRunner.js";
import { enrollContacts } from "../lib/dripRunner.js";
import { fireEvent, logActivity } from "../lib/events.js";
import { loginLimiter, signupLimiter, apiMessageLimiter } from "../lib/rateLimit.js";
import { findApiKeyByRaw, hashApiKey, keyPrefix, publicApiKeyRow } from "../lib/apiKey.js";

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

async function tenantContact(req, id) {
  return prisma.contact.findFirst({ where: { id, companyId: companyIdOf(req) } });
}

const router = express.Router();

// Build the inbox list (contact + last message + unread count).
async function buildConversations(req) {
  const contacts = await prisma.contact.findMany({
    where: tenantWhere(req),
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
router.post("/auth/signup", signupLimiter, async (req, res) => {
  const { name, email, password, company: companyName } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "name, email and password required" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const em = String(email).toLowerCase().trim();
    const coName = String(companyName || name).trim();
    const slug = await uniqueSlug(coName);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * DAY_MS);

    const { getPlatformPricing } = await import("../lib/wallet.js");
    const pricing = await getPlatformPricing();

    const company = await prisma.company.create({
      data: {
        name: coName,
        slug,
        email: em,
        status: "TRIAL",
        plan: "trial",
        trialEndsAt,
        trialStartedAt: new Date(),
        messageCredits: pricing.trialCredits,
        walletBalancePaise: 0,
      },
    });

    const user = await prisma.user.create({
      data: {
        name,
        email: em,
        password: await hashPassword(password),
        role: "OWNER",
        companyId: company.id,
      },
    });

    await prisma.subscription.create({
      data: { companyId: company.id, plan: "trial", status: "active", trialEndsAt },
    });
    await prisma.setting.create({ data: { companyId: company.id, businessName: coName } });
    await prisma.agent.create({
      data: { companyId: company.id, name, email: user.email, role: "Owner" },
    }).catch(() => {});
    await prisma.walletTransaction.create({
      data: {
        companyId: company.id,
        type: "credit",
        reason: "admin_grant",
        amountPaise: 0,
        creditsDelta: pricing.trialCredits,
        balanceAfter: 0,
        creditsAfter: pricing.trialCredits,
        meta: { note: "Trial starter credits" },
      },
    }).catch(() => {});

    res.status(201).json({ token: signToken(user), user: publicCompanyUser(user, company) });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "An account with this email already exists" });
    throw e;
  }
});

// Log in with email + password (bcrypt) against real database accounts only.
router.post("/auth/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const em = String(email || "").toLowerCase().trim();

  const user = await prisma.user.findUnique({
    where: { email: em },
    include: { company: { include: { subscription: true } } },
  });
  if (user?.password && (await comparePassword(password, user.password))) {
    prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date(), lastLoginAt: new Date() } }).catch(() => {});
    if (user.companyId) {
      prisma.company.update({ where: { id: user.companyId }, data: { lastActiveAt: new Date() } }).catch(() => {});
    }
    return res.json({ token: signToken(user), user: publicCompanyUser(user, user.company) });
  }

  return res.status(401).json({ error: "Invalid email or password" });
});

router.get("/me", requireAuth, attachCompany, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { company: { include: { subscription: true } } },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    ...publicCompanyUser(user, req.company || user.company),
    ...(req.user.impersonating
      ? { impersonating: true, impersonatedBy: req.user.impersonatedBy }
      : {}),
  });
});

/* ------------------------- Admin: client management -------------------- */
function requireAdmin(req, res, next) {
  if (isSuperAdmin(req.user)) return next();
  const r = req.user?.role;
  if (r === "OWNER" || r === "Owner" || r === "ADMIN" || r === "Admin") return next();
  return res.status(403).json({ error: "Admin access only" });
}

// All signed-up clients with subscription + revenue + onboarding status.
router.get("/admin/clients", requireAuth, requireAdmin, async (req, res) => {
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({ error: "Super Admin access only" });
  }
  const companies = await prisma.company.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      payments: { where: { status: "paid" } },
      users: { take: 1, orderBy: { createdAt: "asc" } },
    },
  });
  const flowActive = (await prisma.flow.count({ where: { enabled: true } }).catch(() => 0)) > 0;
  const clients = companies.map((c) => {
    const owner = c.users?.[0];
    const trialEndsAt = c.trialEndsAt ? new Date(c.trialEndsAt).getTime() : null;
    const daysLeft = trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / DAY_MS)) : null;
    const plan = normalizePlan(c.plan);
    return {
      id: c.id,
      name: c.name,
      email: owner?.email || c.email,
      ownerId: owner?.id,
      company: c.name,
      role: owner?.role,
      plan,
      status: c.status,
      trialEndsAt,
      trialDaysLeft: daysLeft,
      trialExpired: c.status === "EXPIRED" || (c.status === "TRIAL" && daysLeft === 0),
      chatbotUsed: c.chatbotUsed || flowActive,
      revenue: c.payments.reduce((s, p) => s + p.amount, 0),
      onboardedAt: c.createdAt.getTime(),
      upgradedAt: c.upgradedAt ? c.upgradedAt.getTime() : null,
      lastActiveAt: c.lastActiveAt ? c.lastActiveAt.getTime() : null,
    };
  });
  const summary = {
    total: clients.length,
    onTrial: clients.filter((c) => c.plan === "trial" && !c.trialExpired).length,
    pro: clients.filter((c) => c.plan === "growth").length,
    expired: clients.filter((c) => c.trialExpired).length,
    revenue: clients.reduce((s, c) => s + c.revenue, 0),
  };
  res.json({ clients, summary });
});

// Admin manually sets a client's plan (used for the "manual approve" upgrade path).
router.post("/admin/clients/:id/plan", requireAuth, requireAdmin, async (req, res) => {
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({ error: "Super Admin access only" });
  }
  const { plan } = req.body || {};
  const planKey = normalizePlan(plan);
  if (!["trial", "starter", "growth", "expired"].includes(planKey)) {
    return res.status(400).json({ error: "invalid plan" });
  }
  const data = { plan: planKey };
  if (planKey === "growth" || planKey === "starter") {
    data.status = "ACTIVE";
    data.upgradedAt = new Date();
    data.trialEndsAt = null;
  } else if (planKey === "expired") {
    data.status = "EXPIRED";
  } else if (planKey === "trial") {
    data.status = "TRIAL";
  }
  const company = await prisma.company.update({ where: { id: req.params.id }, data });
  const owner = await prisma.user.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: "asc" } });
  res.json(publicCompanyUser(owner || { id: req.user.id, name: company.name, email: company.email, role: "OWNER", companyId: company.id }, company));
});

/* ------------------------------ Billing -------------------------------- */
// Public billing config — tells the frontend if payments are live + the plan price.
router.get("/billing/config", (_req, res) => {
  res.json({ enabled: RAZORPAY_ENABLED, keyId: RAZORPAY_KEY_ID, plans: PLAN_CATALOG, legacyPlans: PLANS });
});

// Create a Razorpay order for starter or growth plan.
router.post("/billing/create-order", requireAuth, attachCompany, async (req, res) => {
  if (!RAZORPAY_ENABLED) return res.status(503).json({ error: "Payments are not configured yet. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET." });
  const planKey = normalizePlan(req.body?.planKey || req.body?.plan || "growth");
  if (!["starter", "growth"].includes(planKey)) {
    return res.status(400).json({ error: "planKey must be starter or growth" });
  }
  const plan = PLAN_CATALOG[planKey];
  const companyId = companyIdOf(req);
  if (!companyId) return res.status(403).json({ error: "No company linked to this account" });
  try {
    const receipt = `rcpt_${req.user.id.slice(-8)}_${Date.now().toString(36)}`;
    const order = await razorpay().orders.create({ amount: plan.amount, currency: plan.currency, receipt });
    await prisma.payment.create({
      data: {
        userId: req.user.id,
        companyId,
        plan: planKey,
        amount: plan.amount,
        currency: plan.currency,
        status: "created",
        razorpayOrderId: order.id,
      },
    });
    res.json({ orderId: order.id, amount: plan.amount, currency: plan.currency, keyId: RAZORPAY_KEY_ID, planKey });
  } catch (e) {
    console.error("[create-order]", e?.error?.description || e?.message || e);
    res.status(502).json({ error: "Could not start payment. Please try again." });
  }
});

// Verify the payment signature, mark it paid and upgrade the company plan.
router.post("/billing/verify", requireAuth, attachCompany, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  const companyId = companyIdOf(req);
  if (!companyId) return res.status(403).json({ error: "No company linked to this account" });
  if (!verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    await prisma.payment.updateMany({ where: { razorpayOrderId: razorpay_order_id, companyId }, data: { status: "failed" } }).catch(() => {});
    return res.status(400).json({ error: "Payment verification failed" });
  }
  const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: razorpay_order_id } });
  if (!payment || payment.companyId !== companyId) {
    return res.status(404).json({ error: "Payment not found" });
  }

  // Idempotent: webhook may have already credited — never double-credit
  if (payment.status === "paid") {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    return res.json({ ok: true, alreadyProcessed: true, user: publicCompanyUser(user, company) });
  }

  await prisma.payment.update({
    where: { razorpayOrderId: razorpay_order_id },
    data: { status: "paid", razorpayPaymentId: razorpay_payment_id, paidAt: new Date() },
  });

  let company;
  if (payment.type === "wallet_recharge") {
    const pricing = await getPlatformPricing();
    const credits = payment.creditsAdded || creditsFromPaise(payment.amount, pricing.creditsPerRupee);
    const r = await creditWallet({
      companyId,
      amountPaise: payment.amount,
      credits,
      reason: "recharge",
      createdBy: req.user.id,
      meta: { orderId: razorpay_order_id },
    });
    company = r.company;
    if (company.status === "EXPIRED" || company.status === "SUSPENDED") {
      company = await prisma.company.update({
        where: { id: companyId },
        data: { status: "ACTIVE" },
      });
    }
    await prisma.payment.update({
      where: { id: payment.id },
      data: { creditsAdded: credits },
    });
  } else {
    const planKey = normalizePlan(payment.plan);
    company = await prisma.company.update({
      where: { id: companyId },
      data: { plan: planKey, status: "ACTIVE", upgradedAt: new Date(), trialEndsAt: null },
    });
    await prisma.subscription.update({
      where: { companyId },
      data: { plan: planKey, status: "active", activatedAt: new Date(), trialEndsAt: null },
    }).catch(() => {});
    await applyPlanCredits(companyId, planKey, req.user.id).catch(() => {});
    company = await prisma.company.findUnique({ where: { id: companyId } });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  res.json({ ok: true, user: publicCompanyUser(user, company) });
});

// Razorpay webhook — server-to-server confirmation. Reliable even if the client
// closes the browser before /billing/verify runs. Needs express.raw (bypasses
// the global JSON parser via the exclusion in index.js) so the HMAC matches.
router.post("/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  if (!verifyWebhook(req.body, signature)) return res.status(400).send("invalid signature");
  res.sendStatus(200); // ack fast; process after

  try {
    const event = JSON.parse(req.body.toString("utf8"));
    const type = event?.event;
    if (type === "order.paid" || type === "payment.captured") {
      const orderId = event?.payload?.payment?.entity?.order_id || event?.payload?.order?.entity?.id;
      const paymentId = event?.payload?.payment?.entity?.id || null;
      if (!orderId) return;
      const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
      if (!payment || payment.status === "paid") return; // unknown or already handled
      await prisma.payment.update({
        where: { razorpayOrderId: orderId },
        data: { status: "paid", razorpayPaymentId: paymentId, paidAt: new Date() },
      });
      if (payment.companyId) {
        if (payment.type === "wallet_recharge") {
          const { creditWallet, creditsFromPaise, getPlatformPricing } = await import("../lib/wallet.js");
          const pricing = await getPlatformPricing();
          const credits = payment.creditsAdded || creditsFromPaise(payment.amount, pricing.creditsPerRupee);
          await creditWallet({
            companyId: payment.companyId,
            amountPaise: payment.amount,
            credits,
            reason: "recharge",
            meta: { orderId, via: "webhook" },
          });
          await prisma.company.update({
            where: { id: payment.companyId },
            data: { status: "ACTIVE" },
          }).catch(() => {});
        } else {
          const planKey = normalizePlan(payment.plan);
          await prisma.company.update({
            where: { id: payment.companyId },
            data: { plan: planKey, status: "ACTIVE", upgradedAt: new Date(), trialEndsAt: null },
          });
          await prisma.subscription.update({
            where: { companyId: payment.companyId },
            data: { plan: planKey, status: "active", activatedAt: new Date(), trialEndsAt: null },
          }).catch(() => {});
          const { applyPlanCredits } = await import("../lib/wallet.js");
          await applyPlanCredits(payment.companyId, planKey).catch(() => {});
        }
        console.log("[billing] webhook paid", payment.type, payment.companyId, "order", orderId);
      }
    } else if (type === "payment.failed") {
      const orderId = event?.payload?.payment?.entity?.order_id;
      if (orderId) await prisma.payment.updateMany({ where: { razorpayOrderId: orderId }, data: { status: "failed" } }).catch(() => {});
    }
  } catch (e) {
    console.error("[billing] webhook error", e?.message || e);
  }
});

// Public send API (for Zapier / Shopify / custom integrations). Auth via x-api-key.
router.post("/v1/messages", apiMessageLimiter, async (req, res) => {
  const key = req.headers["x-api-key"];
  if (!key) return res.status(401).json({ error: "Missing x-api-key header" });
  const apiKey = await findApiKeyByRaw(String(key));
  if (!apiKey) return res.status(401).json({ error: "Invalid API key" });
  const plan = normalizePlan(apiKey.company?.plan || "trial");
  if (!hasFeature(plan, "api")) {
    return res.status(403).json({ error: "Your plan does not include api", code: "FEATURE_LOCKED", feature: "api", plan });
  }
  if (apiKey.company?.status === "SUSPENDED") {
    return res.status(403).json({ error: "Account suspended", code: "SUSPENDED" });
  }
  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  const { to, text, template, params, language = "en" } = req.body || {};
  if (!to) return res.status(400).json({ error: "to (phone number) required" });
  const pricing = await getPlatformPricing();
  const creditsNeeded = pricing.creditPerOutbound || 1;
  try {
    await spendCredits(apiKey.companyId, creditsNeeded, "api_message_send", {
      to,
      template: template || null,
      channel: "api_key",
    });
  } catch (e) {
    return res.status(e.status || 402).json({ error: e.message, code: e.code || "NO_CREDITS" });
  }
  const creds = await getCompanyCreds(apiKey.companyId);
  try {
    let result;
    if (template) {
      result = params?.length
        ? await sendTemplateWithParams(to, template, params, language, creds)
        : await sendTemplate(to, template, language, creds);
    } else if (text) {
      result = await sendText(to, text, creds);
    } else {
      await refundCredits(apiKey.companyId, creditsNeeded, "api_message_refund", { reason: "missing body" }).catch(() => {});
      return res.status(400).json({ error: "text or template required" });
    }
    const cleanPhone = String(to).replace(/[^\d]/g, "");
    const contact = await prisma.contact.findFirst({ where: { companyId: apiKey.companyId, phone: cleanPhone } });
    if (contact) {
      await prisma.message.create({
        data: {
          companyId: apiKey.companyId,
          contactId: contact.id,
          waId: result.messages?.[0]?.id || null,
          direction: "out",
          type: template ? "template" : "text",
          text: text || `[Template: ${template}]`,
          status: "sent",
        },
      });
    }
    res.json({ ok: true, messageId: result.messages?.[0]?.id || null });
  } catch (e) {
    await refundCredits(apiKey.companyId, creditsNeeded, "api_message_refund", {
      to,
      reason: e.message,
      template: template || null,
      channel: "api_key",
    }).catch(() => {});
    res.status(502).json({ error: e.message });
  }
});

router.use(requireAuth);
router.use(attachCompany);

/* ------------------------------ Contacts ------------------------------- */
router.get("/contacts", async (req, res) => {
  const contacts = await prisma.contact.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(contacts.map((c) => ({ ...c, createdAt: c.createdAt.getTime() })));
});

router.post("/contacts", async (req, res) => {
  const { name, phone, tags = [] } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "name and phone required" });
  const cleanPhone = String(phone).replace(/[^\d]/g, "");
  const count = await prisma.contact.count({ where: tenantWhere(req) });
  try {
    const contact = await prisma.contact.create({
      data: {
        companyId: companyIdOf(req),
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
    const deleted = await prisma.contact.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

// Bulk import contacts (from a parsed CSV). Skips invalid rows and duplicates.
router.post("/contacts/import", async (req, res) => {
  const { contacts } = req.body || {};
  if (!Array.isArray(contacts)) return res.status(400).json({ error: "contacts array required" });
  const start = await prisma.contact.count({ where: tenantWhere(req) });
  let added = 0, skipped = 0;
  for (const c of contacts) {
    const phone = String(c.phone || "").replace(/[^\d]/g, "");
    if (!phone || !c.name) { skipped++; continue; }
    const tags = Array.isArray(c.tags)
      ? c.tags
      : String(c.tags || "").split(/[;|]/).map((t) => t.trim()).filter(Boolean);
    try {
      await prisma.contact.create({
        data: { companyId: companyIdOf(req), name: String(c.name).trim(), phone, tags, color: pickColor(start + added) },
      });
      added++;
    } catch {
      skipped++; // duplicate phone / invalid
    }
  }
  res.json({ added, skipped });
});

// Send a media file (image / document / video / audio) to a contact.
router.post("/conversations/:id/media", requireNotSuspended, upload.single("file"), async (req, res) => {
  const contact = await tenantContact(req, req.params.id);
  if (!contact) return res.sendStatus(404);
  if (!req.file) return res.status(400).json({ error: "file required" });

  const companyId = companyIdOf(req);
  const pricing = await getPlatformPricing();
  const creditsNeeded = pricing.creditPerOutbound || 1;
  try {
    await spendCredits(companyId, creditsNeeded, "message_send", { to: contact.phone, type: "media" });
  } catch (e) {
    return res.status(e.status || 402).json({ error: e.message, code: e.code || "NO_CREDITS" });
  }

  const { originalname, mimetype, filename, path: tmpPath } = req.file;
  const storedName = filename + (path.extname(originalname) || "");
  fs.renameSync(tmpPath, path.join(UPLOAD_DIR, storedName));
  const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${storedName}`;
  const waType = waMediaType(mimetype);
  const caption = req.body?.caption || "";
  const creds = await getCompanyCreds(companyId);

  let waId = null;
  try {
    const mediaId = await uploadMedia(fs.readFileSync(path.join(UPLOAD_DIR, storedName)), mimetype, originalname, creds);
    if (mediaId) {
      const r = await sendMediaById(contact.phone, waType, mediaId, { filename: originalname, caption }, creds);
      waId = r.messages?.[0]?.id || null;
    }
  } catch (e) {
    await refundCredits(companyId, creditsNeeded, "message_refund", {
      to: contact.phone,
      reason: e.message,
      type: "media",
    }).catch(() => {});
    return res.status(502).json({ error: e.message });
  }

  const msg = await prisma.message.create({
    data: {
      companyId,
      contactId: contact.id,
      waId,
      direction: "out",
      type: waType,
      text: caption || originalname,
      mediaUrl: publicUrl,
      filename: originalname,
      status: "sent",
    },
  });
  res.status(201).json(toMessage(msg));
});

// Update chat status (open | pending | resolved).
router.patch("/conversations/:id/status", async (req, res) => {
  const { status } = req.body || {};
  if (!["open", "pending", "resolved"].includes(status)) return res.status(400).json({ error: "invalid status" });
  try {
    const existing = await tenantContact(req, req.params.id);
    if (!existing) return res.sendStatus(404);
    const c = await prisma.contact.update({ where: { id: existing.id }, data: { chatStatus: status } });
    fireEvent("chat.status", { name: c.name, phone: c.phone, status }).catch(() => {});
    logActivity(c.id, "status", `Chat marked ${status}`);

    // On resolve, optionally send a CSAT rating request.
    if (status === "resolved") {
      const s = await prisma.setting.findUnique({ where: { companyId: companyIdOf(req) } });
      if (s?.csatEnabled) {
        try {
          const creds = await getCompanyCreds(companyIdOf(req));
          const r = await sendButtons(c.phone, s.csatMessage, [
            { id: "csat:Great", title: "😀 Great" },
            { id: "csat:Okay", title: "🙂 Okay" },
            { id: "csat:Poor", title: "😞 Poor" },
          ], creds);
          await prisma.message.create({
            data: {
              companyId: companyIdOf(req),
              contactId: c.id,
              waId: r.messages?.[0]?.id || null,
              direction: "out",
              type: "interactive",
              text: s.csatMessage,
              status: "sent",
            },
          });
        } catch (e) { console.error("[csat] send failed:", e.message); }
      }
    }
    res.json({ chatStatus: c.chatStatus });
  } catch {
    res.sendStatus(404);
  }
});

/* ---------------------------- Quick Replies ---------------------------- */
router.get("/quick-replies", async (req, res) => {
  const items = await prisma.quickReply.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(items.map((q) => ({ ...q, createdAt: q.createdAt.getTime() })));
});

router.post("/quick-replies", async (req, res) => {
  const { title, text } = req.body || {};
  if (!title || !text) return res.status(400).json({ error: "title and text required" });
  const q = await prisma.quickReply.create({ data: { companyId: companyIdOf(req), title, text } });
  res.status(201).json({ ...q, createdAt: q.createdAt.getTime() });
});

router.delete("/quick-replies/:id", async (req, res) => {
  try {
    const deleted = await prisma.quickReply.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------------- Agents -------------------------------- */
router.get("/agents", async (req, res) => {
  const agents = await prisma.agent.findMany({ where: tenantWhere(req), orderBy: { createdAt: "asc" } });
  res.json(agents.map((a) => ({ ...a, createdAt: a.createdAt.getTime() })));
});

router.post("/agents", async (req, res) => {
  const { name, email, role = "Agent" } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  const colors = ["#25D366", "#128C7E", "#34B7F1", "#7C3AED", "#F59E0B", "#EF4444"];
  try {
    const count = await prisma.agent.count({ where: tenantWhere(req) });
    const agent = await prisma.agent.create({
      data: { companyId: companyIdOf(req), name, email, role, color: colors[count % colors.length] },
    });
    res.status(201).json({ ...agent, createdAt: agent.createdAt.getTime() });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Agent with this email already exists" });
    throw e;
  }
});

router.delete("/agents/:id", async (req, res) => {
  try {
    const agent = await prisma.agent.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (!agent) return res.sendStatus(404);
    await prisma.contact.updateMany({ where: { assignedAgentId: agent.id, ...tenantWhere(req) }, data: { assignedAgentId: null } });
    await prisma.agent.delete({ where: { id: agent.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

// Assign / unassign a conversation (contact) to an agent.
router.patch("/conversations/:id/assign", async (req, res) => {
  const { agentId } = req.body || {};
  try {
    const existing = await tenantContact(req, req.params.id);
    if (!existing) return res.sendStatus(404);
    if (agentId) {
      const agent = await prisma.agent.findFirst({ where: { id: agentId, ...tenantWhere(req) } });
      if (!agent) return res.status(400).json({ error: "Invalid agent" });
    }
    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: { assignedAgentId: agentId || null },
      include: { assignedAgent: true },
    });
    logActivity(contact.id, "assign", contact.assignedAgent ? `Assigned to ${contact.assignedAgent.name}` : "Unassigned");
    res.json({
      assignedAgent: contact.assignedAgent
        ? { id: contact.assignedAgent.id, name: contact.assignedAgent.name, color: contact.assignedAgent.color }
        : null,
    });
  } catch {
    res.sendStatus(404);
  }
});

// Contact activity timeline (events).
router.get("/conversations/:id/timeline", async (req, res) => {
  const contact = await tenantContact(req, req.params.id);
  if (!contact) return res.sendStatus(404);
  const events = await prisma.event.findMany({ where: { contactId: contact.id }, orderBy: { createdAt: "desc" }, take: 50 });
  res.json(events.map((e) => ({ ...e, createdAt: e.createdAt.getTime() })));
});

/* -------------------------- Contact notes ------------------------------ */
router.get("/conversations/:id/notes", async (req, res) => {
  const contact = await tenantContact(req, req.params.id);
  if (!contact) return res.sendStatus(404);
  const notes = await prisma.note.findMany({ where: { contactId: contact.id }, orderBy: { createdAt: "desc" } });
  res.json(notes.map((n) => ({ ...n, createdAt: n.createdAt.getTime() })));
});

router.post("/conversations/:id/notes", async (req, res) => {
  const { text, author = "You" } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  const contact = await tenantContact(req, req.params.id);
  if (!contact) return res.sendStatus(404);
  const note = await prisma.note.create({ data: { contactId: contact.id, text, author } });
  logActivity(contact.id, "note", "Note added");
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
    const existing = await tenantContact(req, req.params.id);
    if (!existing) return res.sendStatus(404);
    const contact = await prisma.contact.update({ where: { id: existing.id }, data: { attributes: attributes || {} } });
    res.json({ attributes: contact.attributes });
  } catch {
    res.sendStatus(404);
  }
});

/* --------------------------- Product catalog --------------------------- */
router.get("/products", async (req, res) => {
  const products = await prisma.product.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(products.map((p) => ({ ...p, createdAt: p.createdAt.getTime() })));
});

router.post("/products", async (req, res) => {
  const { name, price = "", description = "", imageUrl = "" } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const product = await prisma.product.create({ data: { companyId: companyIdOf(req), name, price, description, imageUrl } });
  res.status(201).json({ ...product, createdAt: product.createdAt.getTime() });
});

router.delete("/products/:id", async (req, res) => {
  try {
    const deleted = await prisma.product.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------------ Segments ------------------------------- */
router.get("/segments", async (req, res) => {
  const segments = await prisma.segment.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  const withCounts = await Promise.all(
    segments.map(async (s) => ({
      ...s,
      createdAt: s.createdAt.getTime(),
      count: await prisma.contact.count({
        where: { ...(await resolveAudience(`segment: ${s.name}`, companyIdOf(req))), ...tenantWhere(req) },
      }),
    }))
  );
  res.json(withCounts);
});

router.post("/segments", async (req, res) => {
  const { name, tags = [], match = "any" } = req.body || {};
  if (!name || !Array.isArray(tags) || !tags.length) return res.status(400).json({ error: "name and tags required" });
  const seg = await prisma.segment.create({ data: { companyId: companyIdOf(req), name, tags, match } });
  res.status(201).json({ ...seg, createdAt: seg.createdAt.getTime() });
});

router.delete("/segments/:id", async (req, res) => {
  try {
    const deleted = await prisma.segment.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------------- Labels -------------------------------- */
router.get("/labels", async (req, res) => {
  const labels = await prisma.label.findMany({ where: tenantWhere(req), orderBy: { createdAt: "asc" } });
  res.json(labels.map((l) => ({ ...l, createdAt: l.createdAt.getTime() })));
});

router.post("/labels", async (req, res) => {
  const { name, color = "#25D366" } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const label = await prisma.label.create({ data: { companyId: companyIdOf(req), name, color } });
  res.status(201).json({ ...label, createdAt: label.createdAt.getTime() });
});

router.delete("/labels/:id", async (req, res) => {
  try {
    const deleted = await prisma.label.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

// Set the labels on a conversation (contact).
router.patch("/conversations/:id/labels", async (req, res) => {
  const { labels } = req.body || {};
  try {
    const existing = await tenantContact(req, req.params.id);
    if (!existing) return res.sendStatus(404);
    const c = await prisma.contact.update({
      where: { id: existing.id },
      data: { labels: Array.isArray(labels) ? labels : [] },
    });
    logActivity(c.id, "label", c.labels.length ? `Labels: ${c.labels.join(", ")}` : "Labels cleared");
    res.json({ labels: c.labels });
  } catch {
    res.sendStatus(404);
  }
});

/* ----------------------------- Inbox / chat ---------------------------- */
router.get("/conversations", async (req, res) => res.json(await buildConversations(req)));

// Full-text search across all message content — returns matching chats + snippet.
router.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  const messages = await prisma.message.findMany({
    where: { text: { contains: q, mode: "insensitive" }, ...tenantWhere(req) },
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
  const contact = await prisma.contact.findFirst({
    where: { id: req.params.id, ...tenantWhere(req) },
    include: { assignedAgent: true },
  });
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

router.post("/conversations/:id/messages", requireNotSuspended, async (req, res) => {
  const contact = await tenantContact(req, req.params.id);
  if (!contact) return res.sendStatus(404);
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  const companyId = companyIdOf(req);

  const pricing = await getPlatformPricing();
  const creditsNeeded = pricing.creditPerOutbound || 1;
  try {
    await spendCredits(companyId, creditsNeeded, "message_send", { to: contact.phone });
  } catch (e) {
    return res.status(e.status || 402).json({ error: e.message, code: e.code || "NO_CREDITS" });
  }

  const creds = await getCompanyCreds(companyId);
  let waId = null;
  try {
    const result = await sendText(contact.phone, text, creds);
    waId = result.messages?.[0]?.id || null;
  } catch (e) {
    await refundCredits(companyId, creditsNeeded, "message_refund", {
      to: contact.phone,
      reason: e.message,
    }).catch(() => {});
    return res.status(502).json({ error: e.message });
  }

  const msg = await prisma.message.create({
    data: {
      companyId,
      contactId: contact.id,
      waId,
      direction: "out",
      type: "text",
      text,
      status: "sent",
    },
  });
  res.status(201).json(toMessage(msg));
});

// Send an approved template to a contact (business-initiated — works outside the 24h window).
router.post("/conversations/:id/send-template", requireNotSuspended, async (req, res) => {
  const contact = await tenantContact(req, req.params.id);
  if (!contact) return res.sendStatus(404);
  const { template, params = [], language = "en" } = req.body || {};
  if (!template) return res.status(400).json({ error: "template required" });
  const companyId = companyIdOf(req);

  const pricing = await getPlatformPricing();
  const creditsNeeded = pricing.creditPerOutbound || 1;
  try {
    await spendCredits(companyId, creditsNeeded, "message_send", { to: contact.phone, template });
  } catch (e) {
    return res.status(e.status || 402).json({ error: e.message, code: e.code || "NO_CREDITS" });
  }

  const creds = await getCompanyCreds(companyId);
  let waId = null;
  try {
    const result = params.length
      ? await sendTemplateWithParams(contact.phone, template, params, language, creds)
      : await sendTemplate(contact.phone, template, language, creds);
    waId = result.messages?.[0]?.id || null;
  } catch (e) {
    await refundCredits(companyId, creditsNeeded, "message_refund", {
      to: contact.phone,
      reason: e.message,
      template,
    }).catch(() => {});
    return res.status(502).json({ error: e.message });
  }

  const tpl = await prisma.template.findFirst({ where: { name: template, ...tenantWhere(req) } });
  let text = tpl?.body || `[Template: ${template}]`;
  params.forEach((p, i) => { text = text.replace(`{{${i + 1}}}`, p); });

  const msg = await prisma.message.create({
    data: {
      companyId: companyIdOf(req),
      contactId: contact.id,
      waId,
      direction: "out",
      type: "template",
      text,
      status: "sent",
    },
  });
  res.status(201).json(toMessage(msg));
});

/* ------------------------------ Templates ------------------------------ */
router.get("/templates", async (req, res) => {
  const templates = await prisma.template.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(templates.map((t) => ({ ...t, createdAt: t.createdAt.getTime() })));
});

router.post("/templates", async (req, res) => {
  const { name, category = "Utility", language = "en", body, headerType, headerText, headerImageUrl, buttons, format = "text", cards } = req.body || {};
  if (!name || !body) return res.status(400).json({ error: "name and body required" });
  const cleanName = String(name).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

  let status = "pending";
  let metaError = null;
  if (WA_LIVE) {
    try {
      const r = format === "carousel" && Array.isArray(cards) && cards.length
        ? await createCarouselTemplate({ name: cleanName, category, language, body, cards })
        : await createTemplate({ name: cleanName, category, language, body, headerType, headerText, headerImageUrl, buttons });
      status = (r.status || "pending").toLowerCase();
    } catch (e) {
      metaError = e.message;
    }
  }

  try {
    const tpl = await prisma.template.create({
      data: {
        companyId: companyIdOf(req),
        name: cleanName,
        category,
        language,
        body,
        status,
        format,
        cards: format === "carousel" ? cards : undefined,
      },
    });
    res.status(201).json({ ...tpl, createdAt: tpl.createdAt.getTime(), metaError });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Template name already exists" });
    throw e;
  }
});

// Pull the latest template statuses from Meta and reconcile the local list.
router.post("/templates/sync", async (req, res) => {
  if (!WA_LIVE) return res.status(400).json({ error: "Not in live mode" });
  try {
    const metaTemplates = await listTemplates();
    for (const mt of metaTemplates) {
      const status = (mt.status || "").toLowerCase();
      const existing = await prisma.template.findFirst({ where: { name: mt.name, ...tenantWhere(req) } });
      if (existing) {
        await prisma.template.update({ where: { id: existing.id }, data: { status, category: cap(mt.category), language: mt.language } });
      } else {
        await prisma.template.create({
          data: {
            companyId: companyIdOf(req),
            name: mt.name,
            status,
            category: cap(mt.category),
            language: mt.language,
            body: "(synced from Meta — edit in WhatsApp Manager)",
          },
        });
      }
    }
    const all = await prisma.template.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
    res.json(all.map((t) => ({ ...t, createdAt: t.createdAt.getTime() })));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ------------------------------ Campaigns ------------------------------ */
router.get("/campaigns", async (req, res) => {
  const campaigns = await prisma.campaign.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(campaigns.map((c) => ({ ...c, createdAt: c.createdAt.getTime(), scheduledAt: c.scheduledAt?.getTime() || null })));
});

router.post("/campaigns", requireNotSuspended, async (req, res) => {
  const { name, template, audience = "All contacts", scheduledAt } = req.body || {};
  if (!name || !template) return res.status(400).json({ error: "name and template required" });
  const audienceWhere = await resolveAudience(audience, companyIdOf(req));
  const recipients = await prisma.contact.count({ where: { ...audienceWhere, ...tenantWhere(req) } });
  const campaign = await prisma.campaign.create({
    data: {
      companyId: companyIdOf(req),
      name,
      template,
      audience,
      recipients,
      status: "scheduled",
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    },
  });
  res.status(201).json({ ...campaign, createdAt: campaign.createdAt.getTime(), scheduledAt: campaign.scheduledAt?.getTime() || null });
});

// Broadcast engine — send now (the scheduler auto-runs scheduled ones).
router.post("/campaigns/:id/send", requireNotSuspended, async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!campaign) return res.sendStatus(404);
  if (campaign.status === "running") return res.status(409).json({ error: "Campaign already running" });
  res.json({ ok: true, status: "running" });
  runCampaign(campaign.id).catch((e) => console.error("[campaign] run error:", e.message));
});

/* ----------------------------- Drip campaigns -------------------------- */
router.get("/drips", async (req, res) => {
  const drips = await prisma.drip.findMany({
    where: tenantWhere(req),
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { enrollments: true } } },
  });
  res.json(drips.map((d) => ({ ...d, createdAt: d.createdAt.getTime(), enrolled: d._count.enrollments })));
});

router.post("/drips", async (req, res) => {
  const { name, steps } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const drip = await prisma.drip.create({
    data: {
      companyId: companyIdOf(req),
      name,
      steps: Array.isArray(steps) ? steps : [{ template: "", delayHours: 0 }],
    },
  });
  res.status(201).json({ ...drip, createdAt: drip.createdAt.getTime(), enrolled: 0 });
});

router.patch("/drips/:id", async (req, res) => {
  const { name, enabled, steps } = req.body || {};
  try {
    const existing = await prisma.drip.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (!existing) return res.sendStatus(404);
    const drip = await prisma.drip.update({
      where: { id: existing.id },
      data: { ...(name !== undefined && { name }), ...(enabled !== undefined && { enabled }), ...(steps !== undefined && { steps }) },
    });
    res.json({ ...drip, createdAt: drip.createdAt.getTime() });
  } catch {
    res.sendStatus(404);
  }
});

router.delete("/drips/:id", async (req, res) => {
  try {
    const existing = await prisma.drip.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (!existing) return res.sendStatus(404);
    await prisma.drip.delete({ where: { id: existing.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

// Enroll an audience into a drip.
router.post("/drips/:id/enroll", requireNotSuspended, async (req, res) => {
  const { audience = "All contacts" } = req.body || {};
  const drip = await prisma.drip.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!drip) return res.sendStatus(404);
  const audienceWhere = await resolveAudience(audience, companyIdOf(req));
  const contacts = await prisma.contact.findMany({ where: { ...audienceWhere, ...tenantWhere(req) } });
  const enrolled = await enrollContacts(drip.id, contacts);
  res.json({ enrolled });
});

/* ----------------------------- Automations ----------------------------- */
router.get("/automations", async (req, res) => {
  const items = await prisma.automation.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(items.map((a) => ({ ...a, createdAt: a.createdAt.getTime() })));
});

router.post("/automations", async (req, res) => {
  const { name, keyword = "", matchType = "contains", reply } = req.body || {};
  if (!name || !reply) return res.status(400).json({ error: "name and reply required" });
  const a = await prisma.automation.create({ data: { companyId: companyIdOf(req), name, keyword, matchType, reply } });
  res.status(201).json({ ...a, createdAt: a.createdAt.getTime() });
});

router.patch("/automations/:id", async (req, res) => {
  const { enabled, name, keyword, matchType, reply } = req.body || {};
  try {
    const existing = await prisma.automation.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (!existing) return res.sendStatus(404);
    const a = await prisma.automation.update({
      where: { id: existing.id },
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
    const deleted = await prisma.automation.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------- Chatbot Flows ------------------------------- */
router.get("/flows", async (req, res) => {
  const flows = await prisma.flow.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
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
    data: {
      companyId: companyIdOf(req),
      name,
      triggerType,
      trigger,
      steps: Array.isArray(steps) && steps.length ? steps : defaultSteps,
    },
  });
  res.status(201).json({ ...flow, createdAt: flow.createdAt.getTime() });
});

router.patch("/flows/:id", async (req, res) => {
  const { name, triggerType, trigger, enabled, steps } = req.body || {};
  try {
    const existing = await prisma.flow.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (!existing) return res.sendStatus(404);
    const flow = await prisma.flow.update({
      where: { id: existing.id },
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
    const existing = await prisma.flow.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (!existing) return res.sendStatus(404);
    await prisma.contact.updateMany({ where: { activeFlowId: existing.id, ...tenantWhere(req) }, data: { activeFlowId: null, activeFlowStep: null } });
    await prisma.flow.delete({ where: { id: existing.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------------ Settings ------------------------------- */
router.get("/settings", async (req, res) => {
  const companyId = companyIdOf(req);
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: {},
    create: { companyId, businessName: req.company?.name || "Nexwapi" },
  });
  const wa = await prisma.whatsAppAccount.findFirst({
    where: { companyId, isDefault: true },
  });
  res.json({
    ...s,
    whatsappConnected: Boolean(wa?.isConnected),
    whatsapp: wa
      ? {
          id: wa.id,
          businessName: wa.businessName || wa.verifiedName,
          phoneNumber: wa.displayPhoneNumber || wa.phoneNumber,
          qualityRating: wa.qualityRating,
          messagingLimit: wa.messagingLimit,
          verificationStatus: wa.verificationStatus,
          webhookStatus: wa.webhookStatus,
          connectedSince: wa.connectedAt ? wa.connectedAt.getTime() : null,
          status: wa.status,
        }
      : null,
    meta: {
      embeddedSignupReady: Boolean(process.env.WHATSAPP_APP_ID && process.env.WHATSAPP_CONFIG_ID),
      appId: process.env.WHATSAPP_APP_ID || null,
      configId: process.env.WHATSAPP_CONFIG_ID || null,
      graphVersion: process.env.WHATSAPP_API_VERSION || "v22.0",
    },
  });
});

/* --------------------- Client WhatsApp account ------------------------ */
router.get("/whatsapp/account", async (req, res) => {
  const companyId = companyIdOf(req);
  const wa = await prisma.whatsAppAccount.findFirst({ where: { companyId, isDefault: true } });
  if (!wa) return res.json({ connected: false, account: null });
  res.json({
    connected: wa.isConnected,
    account: {
      id: wa.id,
      businessName: wa.businessName || wa.verifiedName,
      phoneNumber: wa.displayPhoneNumber || wa.phoneNumber,
      phoneNumberId: wa.phoneNumberId,
      wabaId: wa.wabaId,
      qualityRating: wa.qualityRating || "UNKNOWN",
      messagingLimit: wa.messagingLimit || "—",
      verificationStatus: wa.verificationStatus || "unverified",
      webhookStatus: wa.webhookStatus,
      connectedSince: wa.connectedAt ? wa.connectedAt.getTime() : null,
      status: wa.status,
      lastError: wa.lastError,
      hasToken: Boolean(wa.accessToken),
      live: Boolean(wa.phoneNumberId && wa.accessToken),
    },
    webhook: {
      url: `${process.env.PUBLIC_API_URL || ""}/api/whatsapp/webhook`,
      verifyToken: wa.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || null,
    },
  });
});

// Manual connect — client onboarding with real number + optional Meta Cloud API credentials.
router.post("/whatsapp/connect", async (req, res) => {
  const companyId = companyIdOf(req);
  const {
    phoneNumberId,
    wabaId,
    accessToken,
    businessName,
    displayPhoneNumber,
    phoneNumber,
    verifyToken,
  } = req.body || {};

  const display = String(displayPhoneNumber || phoneNumber || "").trim();
  const biz = String(businessName || req.company?.name || "").trim();
  if (!display) return res.status(400).json({ error: "WhatsApp phone number is required" });
  if (!biz) return res.status(400).json({ error: "Business name is required" });

  const cleanPhone = display.replace(/[^\d+]/g, "");
  const hasMeta = Boolean(phoneNumberId && accessToken);
  const existing = await prisma.whatsAppAccount.findFirst({ where: { companyId, isDefault: true } });

  let qualityRating = existing?.qualityRating || null;
  let messagingLimit = existing?.messagingLimit || null;
  let verificationStatus = hasMeta ? "pending" : "unverified";
  let verifiedName = null;
  let metaPhone = null;
  let lastError = null;

  // If Meta credentials provided, verify against Graph API and pull live metadata.
  if (hasMeta) {
    try {
      const ver = process.env.WHATSAPP_API_VERSION || "v22.0";
      const url = `https://graph.facebook.com/${ver}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier&access_token=${encodeURIComponent(accessToken)}`;
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok) {
        lastError = j?.error?.message || "Meta API rejected credentials";
        return res.status(400).json({ error: lastError, meta: j?.error || null });
      }
      metaPhone = j.display_phone_number || null;
      verifiedName = j.verified_name || null;
      qualityRating = j.quality_rating || "UNKNOWN";
      messagingLimit = j.messaging_limit_tier || j.messaging_limit || "—";
      verificationStatus = "verified";
    } catch (e) {
      return res.status(502).json({ error: e?.message || "Could not reach Meta API" });
    }
  }

  const data = {
    phoneNumberId: phoneNumberId || existing?.phoneNumberId || null,
    wabaId: wabaId || existing?.wabaId || null,
    accessToken: accessToken || existing?.accessToken || null,
    businessName: biz,
    verifiedName: verifiedName || existing?.verifiedName || null,
    displayPhoneNumber: metaPhone || display,
    phoneNumber: cleanPhone,
    verifyToken: verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || existing?.verifyToken || `nex_${companyId.slice(-8)}`,
    isConnected: true,
    status: "connected",
    qualityRating,
    messagingLimit,
    verificationStatus,
    webhookStatus: hasMeta ? "pending" : "pending",
    connectedAt: existing?.connectedAt || new Date(),
    lastSyncAt: new Date(),
    lastError,
  };

  const wa = existing
    ? await prisma.whatsAppAccount.update({ where: { id: existing.id }, data })
    : await prisma.whatsAppAccount.create({ data: { ...data, companyId, isDefault: true } });

  const host = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`;
  res.json({
    ok: true,
    live: hasMeta,
    account: wa,
    webhook: {
      url: `${host}/api/whatsapp/webhook`,
      verifyToken: wa.verifyToken,
      fields: ["messages", "message_template_status_update"],
    },
  });
});

router.post("/whatsapp/disconnect", async (req, res) => {
  const companyId = companyIdOf(req);
  await prisma.whatsAppAccount.updateMany({
    where: { companyId },
    data: { isConnected: false, status: "disconnected", accessToken: null, webhookStatus: "pending" },
  });
  res.json({ ok: true });
});

router.post("/whatsapp/refresh", async (req, res) => {
  const companyId = companyIdOf(req);
  const wa = await prisma.whatsAppAccount.findFirst({ where: { companyId, isDefault: true } });
  if (!wa) return res.status(404).json({ error: "No WhatsApp account" });
  if (!wa.accessToken) return res.status(400).json({ error: "No access token stored — reconnect via Facebook" });

  try {
    const longLived = await exchangeForLongLivedToken(wa.accessToken);
    const token = longLived.access_token || wa.accessToken;
    let phoneMeta = null;
    if (wa.phoneNumberId) {
      phoneMeta = await fetchPhoneDetails(wa.phoneNumberId, token).catch(() => null);
    }
    const updated = await prisma.whatsAppAccount.update({
      where: { id: wa.id },
      data: {
        accessToken: token,
        tokenExpiresAt: longLived.expires_in
          ? new Date(Date.now() + Number(longLived.expires_in) * 1000)
          : wa.tokenExpiresAt,
        qualityRating: phoneMeta?.quality_rating || wa.qualityRating,
        messagingLimit: phoneMeta?.messaging_limit_tier || wa.messagingLimit,
        verifiedName: phoneMeta?.verified_name || wa.verifiedName,
        displayPhoneNumber: phoneMeta?.display_phone_number || wa.displayPhoneNumber,
        lastSyncAt: new Date(),
        lastError: null,
        isConnected: true,
        status: "connected",
      },
    });
    res.json({ ok: true, account: updated });
  } catch (e) {
    await prisma.whatsAppAccount.update({
      where: { id: wa.id },
      data: { lastError: e.message, lastSyncAt: new Date() },
    }).catch(() => {});
    res.status(400).json({ error: e.message || "Token refresh failed — please reconnect WhatsApp" });
  }
});

/* -------- Meta Embedded Signup (Facebook Login) -------- */
router.get("/whatsapp/meta-config", (_req, res) => {
  const host = process.env.PUBLIC_API_URL || "";
  res.json({
    ...metaSignupConfig(),
    webhookUrl: `${host}/api/whatsapp/webhook`,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || null,
  });
});

router.post("/whatsapp/embedded-signup", async (req, res) => {
  const companyId = companyIdOf(req);
  const { code, redirectUri, wabaId, phoneNumberId, businessId } = req.body || {};
  if (!code) return res.status(400).json({ error: "OAuth code required from Facebook Login" });

  try {
    const tokenData = await exchangeCodeForToken(code, redirectUri || process.env.WHATSAPP_REDIRECT_URI);
    let accessToken = tokenData.access_token;
    if (!accessToken) return res.status(400).json({ error: "No access token from Meta" });

    // Upgrade to long-lived token (~60 days) for production reliability
    let expiresIn = tokenData.expires_in;
    try {
      const longLived = await exchangeForLongLivedToken(accessToken);
      if (longLived.access_token) {
        accessToken = longLived.access_token;
        expiresIn = longLived.expires_in || expiresIn;
      }
    } catch (e) {
      console.warn("[embedded-signup] long-lived exchange skipped:", e.message);
    }

    let finalWaba = wabaId;
    let finalPhoneId = phoneNumberId;
    let phoneMeta = null;
    let finalBusinessId = businessId || null;

    // Discover WABA from Graph if session payload didn't arrive yet
    if (!finalWaba) {
      const shared = await fetchSharedWabas(accessToken).catch(() => []);
      if (shared[0]) {
        finalWaba = shared[0].id;
        finalBusinessId = finalBusinessId || shared[0].businessId;
      }
    }

    if (finalWaba && !finalPhoneId) {
      const phones = await fetchPhoneNumbers(finalWaba, accessToken);
      if (phones[0]) {
        finalPhoneId = phones[0].id;
        phoneMeta = phones[0];
      }
    }
    if (finalPhoneId && !phoneMeta) {
      phoneMeta = await fetchPhoneDetails(finalPhoneId, accessToken);
    }
    if (!finalPhoneId) {
      return res.status(400).json({
        error: "phoneNumberId required — complete Embedded Signup and pass session info, then retry",
      });
    }

    if (finalWaba) {
      await subscribeWabaWebhooks(finalWaba, accessToken).catch((e) =>
        console.warn("[wa] subscribe webhook:", e.message)
      );
    }

    const existing = await prisma.whatsAppAccount.findFirst({ where: { companyId, isDefault: true } });
    const data = {
      businessId: finalBusinessId || null,
      wabaId: finalWaba || null,
      phoneNumberId: finalPhoneId,
      accessToken,
      displayPhoneNumber: phoneMeta?.display_phone_number || null,
      phoneNumber: String(phoneMeta?.display_phone_number || "").replace(/[^\d]/g, "") || null,
      businessName: phoneMeta?.verified_name || req.company?.name || null,
      verifiedName: phoneMeta?.verified_name || null,
      qualityRating: phoneMeta?.quality_rating || "UNKNOWN",
      messagingLimit: phoneMeta?.messaging_limit_tier || "—",
      verificationStatus: "verified",
      webhookStatus: finalWaba ? "connected" : "pending",
      isConnected: true,
      status: "connected",
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || `nex_${companyId.slice(-8)}`,
      connectedAt: new Date(),
      lastSyncAt: new Date(),
      lastError: null,
      tokenExpiresAt: expiresIn
        ? new Date(Date.now() + Number(expiresIn) * 1000)
        : null,
    };

    const wa = existing
      ? await prisma.whatsAppAccount.update({ where: { id: existing.id }, data })
      : await prisma.whatsAppAccount.create({ data: { ...data, companyId, isDefault: true } });

    const host = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`;
    res.json({
      ok: true,
      live: true,
      account: wa,
      webhook: {
        url: `${host}/api/whatsapp/webhook`,
        verifyToken: wa.verifyToken,
      },
    });
  } catch (e) {
    console.error("[embedded-signup]", e.message);
    res.status(400).json({ error: e.message || "Embedded Signup failed" });
  }
});

/* ------------------------------ Wallet -------------------------------- */
router.get("/wallet", async (req, res) => {
  const companyId = companyIdOf(req);
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const pricing = await getPlatformPricing();
  if (!company) return res.status(404).json({ error: "not found" });
  res.json({
    walletBalancePaise: company.walletBalancePaise,
    messageCredits: company.messageCredits,
    freeAccess: company.freeAccess,
    creditsPerRupee: pricing.creditsPerRupee,
    creditPerOutbound: pricing.creditPerOutbound,
    creditPerInbound: pricing.creditPerInbound,
  });
});

router.get("/wallet/transactions", async (req, res) => {
  const txns = await prisma.walletTransaction.findMany({
    where: tenantWhere(req),
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(txns.map((t) => ({ ...t, createdAt: t.createdAt.getTime() })));
});

router.post("/wallet/recharge", async (req, res) => {
  if (!RAZORPAY_ENABLED) return res.status(503).json({ error: "Payments not configured" });
  const companyId = companyIdOf(req);
  const amountRupees = Math.max(1, Number(req.body?.amountRupees) || 0);
  if (amountRupees < 1) return res.status(400).json({ error: "amountRupees required (min ₹1)" });
  const amount = Math.round(amountRupees * 100);
  const pricing = await getPlatformPricing();
  const credits = creditsFromPaise(amount, pricing.creditsPerRupee);
  try {
    const receipt = `wlt_${req.user.id.slice(-8)}_${Date.now().toString(36)}`;
    const order = await razorpay().orders.create({ amount, currency: "INR", receipt });
    await prisma.payment.create({
      data: {
        userId: req.user.id,
        companyId,
        plan: normalizePlan(req.company?.plan || "trial"),
        type: "wallet_recharge",
        amount,
        currency: "INR",
        status: "created",
        creditsAdded: credits,
        razorpayOrderId: order.id,
      },
    });
    res.json({
      orderId: order.id,
      amount,
      currency: "INR",
      keyId: RAZORPAY_KEY_ID,
      credits,
      creditsPerRupee: pricing.creditsPerRupee,
    });
  } catch (e) {
    console.error("[wallet/recharge]", e?.message || e);
    res.status(502).json({ error: "Could not start wallet recharge" });
  }
});

router.patch("/settings", async (req, res) => {
  const companyId = companyIdOf(req);
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
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: data,
    create: { companyId, businessName: req.company?.name || "Nexwapi", ...data },
  });
  res.json(s);
});

/* ------------------------- Developer API keys -------------------------- */
router.get("/api-keys", async (req, res) => {
  const keys = await prisma.apiKey.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(keys.map(publicApiKeyRow));
});

router.post("/api-keys", requireFeature("api"), async (req, res) => {
  const { name = "Default key" } = req.body || {};
  const rawKey = "nex_" + crypto.randomBytes(24).toString("hex");
  const hashed = `sha256:${hashApiKey(rawKey)}`;
  const k = await prisma.apiKey.create({
    data: { companyId: companyIdOf(req), name, key: hashed },
  });
  res.status(201).json({
    ...publicApiKeyRow(k),
    key: rawKey,
    keyPrefix: keyPrefix(rawKey),
    oneTimeVisible: true,
  });
});

router.delete("/api-keys/:id", async (req, res) => {
  try {
    const deleted = await prisma.apiKey.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* -------------------------- Reports (deep) ----------------------------- */
router.get("/reports", async (req, res) => {
  const tw = tenantWhere(req);
  const agents = await prisma.agent.findMany({ where: tw, orderBy: { createdAt: "asc" } });
  const agentStats = await Promise.all(
    agents.map(async (a) => ({
      name: a.name,
      color: a.color,
      assigned: await prisma.contact.count({ where: { assignedAgentId: a.id, ...tw } }),
      resolved: await prisma.contact.count({ where: { assignedAgentId: a.id, chatStatus: "resolved", ...tw } }),
    }))
  );

  const [open, pending, resolved, contactsTotal, inbound, outbound] = await Promise.all([
    prisma.contact.count({ where: { chatStatus: "open", ...tw } }),
    prisma.contact.count({ where: { chatStatus: "pending", ...tw } }),
    prisma.contact.count({ where: { chatStatus: "resolved", ...tw } }),
    prisma.contact.count({ where: tw }),
    prisma.message.count({ where: { direction: "in", ...tw } }),
    prisma.message.count({ where: { direction: "out", ...tw } }),
  ]);

  const contacts = await prisma.contact.findMany({ where: tw, select: { tags: true } });
  const tagMap = {};
  contacts.forEach((c) => (c.tags || []).forEach((t) => (tagMap[t] = (tagMap[t] || 0) + 1)));
  const topTags = Object.entries(tagMap).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 8);

  const campaigns = await prisma.campaign.findMany({ where: tw, orderBy: { createdAt: "desc" }, take: 6 });

  const withMsgs = await prisma.contact.findMany({ where: tw, include: { messages: { orderBy: { at: "asc" } } } });
  let totalRespMin = 0, responded = 0, inboundContacts = 0;
  for (const c of withMsgs) {
    const firstIn = c.messages.find((m) => m.direction === "in");
    if (!firstIn) continue;
    inboundContacts++;
    const firstOut = c.messages.find((m) => m.direction === "out" && m.at > firstIn.at);
    if (firstOut) { totalRespMin += (firstOut.at - firstIn.at) / 60000; responded++; }
  }
  const avgResponseMinutes = responded ? Math.round(totalRespMin / responded) : 0;
  const responseRate = inboundContacts ? Math.round((responded / inboundContacts) * 100) : 0;

  res.json({
    totals: {
      contacts: contactsTotal,
      messages: inbound + outbound,
      chats: open + pending + resolved,
      resolvedRate: open + pending + resolved ? Math.round((resolved / (open + pending + resolved)) * 100) : 0,
      avgResponseMinutes,
      responseRate,
    },
    agents: agentStats,
    statusBreakdown: { open, pending, resolved },
    messageVolume: { inbound, outbound },
    topTags,
    campaigns: campaigns.map((c) => ({ name: c.name, sent: c.sent, delivered: c.delivered, read: c.read, replied: c.replied })),
  });
});

/* ------------------------------ Analytics ------------------------------ */
router.get("/analytics", async (req, res) => {
  const tw = tenantWhere(req);
  const [contacts, agg, conversations] = await Promise.all([
    prisma.contact.count({ where: tw }),
    prisma.campaign.aggregate({ where: tw, _sum: { sent: true, delivered: true, read: true, replied: true }, _count: true }),
    buildConversations(req),
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
