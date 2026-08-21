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
  uploadMedia, sendMediaById, sendButtons, createCarouselTemplate, getEffectiveCreds, assertLiveCreds,
} from "../lib/whatsappService.js";
import { spendCredits, refundCredits, creditWallet, creditsFromPaise, getPlatformPricing, applyPlanCredits, templateChargeCredits } from "../lib/wallet.js";
import {
  metaSignupConfig, exchangeEmbeddedSignupCode, exchangeForLongLivedToken,
  fetchPhoneNumbers, subscribeWabaWebhooks, fetchPhoneDetails, fetchSharedWabas,
  registerCloudApiPhone,
} from "../lib/metaOAuth.js";

const UPLOAD_DIR = path.resolve("uploads");
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 16 * 1024 * 1024 } }); // 16MB (WhatsApp limit)
const profileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Map a mimetype to the WhatsApp media type.
function waMediaType(mime) {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  return "document";
}
import { WA_LIVE } from "../config/whatsapp.js";
import { ensureStarterMessaging } from "../lib/starterMessaging.js";
import {
  fetchBusinessProfile, updateBusinessProfile, uploadProfilePicture, VERTICALS,
} from "../lib/waBusinessProfile.js";
import { hashPassword, comparePassword, signToken, requireAuth } from "../lib/auth.js";
import {
  attachCompany, companyIdOf, tenantWhere, publicCompanyUser, uniqueSlug,
  requireNotSuspended, requireFeature, isSuperAdmin,
} from "../lib/tenant.js";
import { PLAN_CATALOG, normalizePlan, hasFeature, isPaidPlan, planFeatures } from "../lib/plans.js";
import { createAgentSeat, ensureOwnerAgent, listAgentsEnriched, updateAgentSeat, resetAgentInvitePassword, companySeatUsage, AGENT_ROLES } from "../lib/teamSeats.js";
import {
  getAllRolePermissions,
  saveRolePermissions,
  resolveWorkspaceRole,
  userHasWorkspacePermission,
} from "../lib/workspaceRbac.js";
import { digitsOnly, findCompanyContactByPhone } from "../lib/phone.js";
import { RAZORPAY_ENABLED, RAZORPAY_KEY_ID, PLANS, razorpay, verifySignature, verifyWebhook } from "../lib/razorpay.js";
import { runCampaign, resolveAudience } from "../lib/campaignRunner.js";
import { enrollContacts } from "../lib/dripRunner.js";
import { fireEvent, logActivity } from "../lib/events.js";
import { loginLimiter, signupLimiter, apiMessageLimiter } from "../lib/rateLimit.js";
import { findApiKeyByRaw, hashApiKey, keyPrefix, publicApiKeyRow } from "../lib/apiKey.js";
import { requireApiKey, digitsPhone, publicContact } from "../lib/publicApi.js";
import { mailConfigured, emailDeliveryConfigured, sendWelcome, sendInvoiceEmail, sendCampaignStatus, sendCampaignReportEmail, sendSuspension, sendTemplateStatus, sendSupportTicketAlert } from "../lib/mailer.js";
import {
  commerceOverview, connectCatalog, syncCatalog, getOrCreateCommerceSetting,
  parseProductsCsv, sendCollectionsList, sendCollectionCatalog, commerceUserError,
  checkoutBotOverview, listCommerceOrders, orderPanelMeta, ordersToCsv, serializeCommerceOrder,
} from "../lib/commerce.js";
import {
  listIntegrationsOverview, connectIntegration, disconnectIntegration, getOrCreateIntegration,
  serializeIntegration, handleWooWebhook, handleShopifyWebhook, handleGoogleSheetRow,
  handleFacebookLead, syncWooProducts, syncShopifyProducts, resolveHookCompany,
  rotateIntegrationSecret,
} from "../lib/integrations.js";
import { issueOtp, verifyOtp, requireOtpOrSkip, otpGate } from "../lib/otp.js";
import { notify } from "../lib/notify.js";
import { getLocalWaProfile, saveLocalWaProfile } from "../lib/localWaProfile.js";
import { buildSegmentContactWhere } from "../lib/segmentFilters.js";
import { CONTACT_TRAITS, TRAIT_CONDITIONS, assignContactToAgent, getAssignmentSettings } from "../lib/assignmentEngine.js";
import { clearDelayedReplyFlag, getInboxAutomationSettings, updateInboxAutomationSettings } from "../lib/inboxAutomations.js";
import { formatWorkingHoursSummary, defaultWorkingHoursSlots } from "../lib/businessHours.js";
import { patchAsyncRouter } from "../lib/asyncRouter.js";

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

async function notifyOwnerTemplate(companyId, name, status) {
  try {
    const owner = await prisma.user.findFirst({
      where: { companyId, role: { in: ["OWNER", "ADMIN"] } },
      orderBy: { createdAt: "asc" },
    });
    if (owner?.email) await sendTemplateStatus(owner.email, name, status);
  } catch (e) {
    console.warn("[mail template]", e.message);
  }
}

const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

async function tenantContact(req, id) {
  return prisma.contact.findFirst({ where: { id, companyId: companyIdOf(req) } });
}

const router = express.Router();
patchAsyncRouter(router);

/** Prevent Express 4 async hangs — return JSON instead of leaving requests open. */
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireWorkspace(req, res) {
  const companyId = companyIdOf(req);
  if (!companyId) {
    res.status(403).json({ error: "No workspace linked to this account" });
    return null;
  }
  return companyId;
}

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
  const { name, email, password, company: companyName, otp } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "name, email and password required" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const em = String(email).toLowerCase().trim();
  if (!otp) {
    try {
      const otpResult = await issueOtp(em, "signup", { name, email: em, password, company: companyName });
      return res.json({ otpRequired: true, otpHint: otpResult.otpHint });
    } catch (e) {
      console.error("[signup otp]", e?.message || e);
      return res.status(503).json({ error: "Could not send OTP to your email. Check RESEND_API_KEY or SMTP settings." });
    }
  }
  const v = verifyOtp(em, "signup", otp);
  if (!v.ok) return res.status(400).json({ error: v.error || "Invalid OTP" });
  try {
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
    await prisma.setting.create({ data: { companyId: company.id, businessName: coName, autoAssign: true } });
    await ensureOwnerAgent(company.id, { name, email: em }).catch(() => {});
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

    sendWelcome(user.email, user.name).catch((e) => console.warn("[mail welcome]", e.message));
    res.status(201).json({ token: signToken(user), user: publicCompanyUser(user, company) });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "An account with this email already exists" });
    throw e;
  }
});

// Log in with email + password (bcrypt) against real database accounts only.
router.post("/auth/login", loginLimiter, async (req, res) => {
  const { email, password, otp } = req.body || {};
  const em = String(email || "").toLowerCase().trim();

  const user = await prisma.user.findUnique({
    where: { email: em },
    include: { company: { include: { subscription: true } } },
  });
  if (user?.password && (await comparePassword(password, user.password))) {
    if (user.isActive === false) {
      return res.status(403).json({ error: "This account has been deactivated" });
    }
    // Super Admin bypasses OTP (they authenticate via strong password only).
    // Regular users still go through OTP email verification.
    const skipOtp = user.role === "SUPER_ADMIN";
    if (!skipOtp) {
      if (!otp) {
        let otpResult;
        try {
          otpResult = await issueOtp(em, "login");
        } catch (e) {
          console.error("[login otp]", e?.message || e);
          return res.status(503).json({ error: "Could not send OTP to your email. Check RESEND_API_KEY or SMTP settings." });
        }
        const { emailDeliveryConfigured } = await import("../lib/mailer.js");
        if (!otpResult.emailSent && !otpResult.devConsole && !emailDeliveryConfigured()) {
          console.warn("[login] No email delivery configured — skipping OTP for", em);
        } else {
          return res.json({ otpRequired: true, otpHint: otpResult.otpHint });
        }
      } else {
        const v = verifyOtp(em, "login", otp);
        if (!v.ok) return res.status(400).json({ error: v.error || "Invalid OTP" });
      }
    }
    prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date(), lastLoginAt: new Date() } }).catch(() => {});
    if (user.companyId) {
      prisma.company.update({ where: { id: user.companyId }, data: { lastActiveAt: new Date() } }).catch(() => {});
    }
    prisma.auditLog.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        action: "login",
        entity: "User",
        entityId: user.id,
        meta: { email: user.email, role: user.role },
      },
    }).catch(() => {});
    notify({
      audience: user.role === "SUPER_ADMIN" ? "admin" : "client",
      companyId: user.companyId,
      userId: user.id,
      title: "New sign-in",
      body: `${user.name || user.email} signed in`,
      href: user.role === "SUPER_ADMIN" ? "/admin" : "/dashboard",
    }).catch(() => {});
    return res.json({ token: signToken(user), user: publicCompanyUser(user, user.company) });
  }

  return res.status(401).json({ error: "Invalid email or password" });
});

router.post("/auth/forgot", signupLimiter, async (req, res) => {
  const em = String(req.body?.email || "").toLowerCase().trim();
  res.json({ ok: true });
  if (!em) return;
  const user = await prisma.user.findUnique({ where: { email: em } });
  if (!user) return;
  try {
    const { sendPasswordResetLink } = await import("../lib/mailer.js");
    await issueOtp(em, "reset");
    await sendPasswordResetLink(em, em);
  } catch (e) {
    console.warn("[mail reset]", e.message);
  }
});

router.post("/auth/reset", signupLimiter, async (req, res) => {
  const em = String(req.body?.email || "").toLowerCase().trim();
  const { code, password } = req.body || {};
  if (!em || !code || !password) return res.status(400).json({ error: "email, code and password required" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const v = verifyOtp(em, "reset", code);
  if (!v.ok) return res.status(400).json({ error: v.error || "Invalid OTP" });
  const user = await prisma.user.findUnique({ where: { email: em } });
  if (!user) return res.status(400).json({ error: "Account not found" });
  await prisma.user.update({ where: { id: user.id }, data: { password: await hashPassword(password) } });
  res.json({ ok: true });
});

router.get("/me", requireAuth, attachCompany, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { company: { include: { subscription: true } } },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.isActive === false) return res.status(403).json({ error: "Account disabled" });
  const rbac = user.companyId
    ? await resolveWorkspaceRole({ user, companyId: user.companyId })
    : { role: "Owner", permissions: {} };
  res.json({
    ...publicCompanyUser(user, req.company || user.company),
    workspaceRole: rbac.role,
    workspacePermissions: rbac.permissions,
    ...(req.user.impersonating
      ? { impersonating: true, impersonatedBy: req.user.impersonatedBy }
      : {}),
  });
});

router.patch("/me", requireAuth, attachCompany, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const companyName = String(req.body?.company || req.body?.companyName || "").trim();
  const phone = req.body?.phone != null ? String(req.body.phone).trim() : null;
  const language = req.body?.language != null ? String(req.body.language).trim().toLowerCase() : null;
  const allowedLangs = new Set(["en", "hi", "es", "pt", "id", "ar"]);
  const data = {};
  if (name) data.name = name;
  if (phone != null) data.phone = phone || null;
  if (language && allowedLangs.has(language)) data.language = language;
  if (req.body?.password) {
    const next = String(req.body.password);
    if (next.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const current = String(req.body.currentPassword || "");
    const row = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (row?.password && current) {
      const ok = await comparePassword(current, row.password);
      if (!ok) return res.status(400).json({ error: "Current password is incorrect" });
    }
    data.password = await hashPassword(next);
  }
  const user = Object.keys(data).length
    ? await prisma.user.update({
      where: { id: req.user.id },
      data,
      include: { company: { include: { subscription: true } } },
    })
    : await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { company: { include: { subscription: true } } },
    });
  if (companyName && user.companyId) {
    await prisma.company.update({ where: { id: user.companyId }, data: { name: companyName } });
    await prisma.setting.updateMany({ where: { companyId: user.companyId }, data: { businessName: companyName } });
  }
  const company = user.companyId
    ? await prisma.company.findUnique({ where: { id: user.companyId }, include: { subscription: true } })
    : user.company;
  const rbac = user.companyId
    ? await resolveWorkspaceRole({ user, companyId: user.companyId })
    : { role: "Owner", permissions: {} };
  res.json({
    ...publicCompanyUser({ ...user, name: data.name || user.name }, company),
    workspaceRole: rbac.role,
    workspacePermissions: rbac.permissions,
  });
});

router.post("/otp/send", requireAuth, async (req, res) => {
  try {
    await issueOtp(req.user.email, req.body?.purpose || "login", req.body?.payload || {});
    res.json({ ok: true, otpRequired: emailDeliveryConfigured() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
  if (!["trial", "starter", "growth", "professional", "enterprise", "expired"].includes(planKey)) {
    return res.status(400).json({ error: "invalid plan" });
  }
  const data = { plan: planKey };
  if (isPaidPlan(planKey)) {
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

function moneyInr(paise) {
  return `₹${(Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function assignInvoiceNo(paymentId) {
  const y = new Date();
  const prefix = `NEX-${y.getFullYear()}${String(y.getMonth() + 1).padStart(2, "0")}-`;
  const count = await prisma.payment.count({ where: { invoiceNo: { startsWith: prefix } } });
  const invoiceNo = `${prefix}${String(count + 1).padStart(4, "0")}`;
  await prisma.payment.update({ where: { id: paymentId }, data: { invoiceNo } }).catch(() => {});
  return invoiceNo;
}

async function emailInvoiceFor(payment) {
  try {
    const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
    if (!fresh?.companyId) return;
    const owner = await prisma.user.findFirst({
      where: { companyId: fresh.companyId, role: { in: ["OWNER", "ADMIN"] } },
      orderBy: { createdAt: "asc" },
    });
    if (owner?.email) {
      await sendInvoiceEmail(owner.email, { invoiceNo: fresh.invoiceNo, amount: fresh.amount, plan: fresh.plan });
    }
  } catch (e) {
    console.warn("[mail invoice]", e.message);
  }
}
// Public billing config — tells the frontend if payments are live + the plan price.
router.get("/billing/config", async (_req, res) => {
  const rows = await prisma.plan.findMany().catch(() => []);
  const plans = { ...PLAN_CATALOG };
  for (const row of rows) {
    if (plans[row.key]) plans[row.key] = { ...plans[row.key], amount: row.amount, name: row.name };
  }
  res.json({ enabled: RAZORPAY_ENABLED, keyId: RAZORPAY_KEY_ID, plans, legacyPlans: PLANS });
});

// Create a Razorpay order for starter or growth plan.
router.post("/billing/create-order", requireAuth, attachCompany, async (req, res) => {
  if (!RAZORPAY_ENABLED) return res.status(503).json({ error: "Payments are not configured yet. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET." });
  const planKey = normalizePlan(req.body?.planKey || req.body?.plan || "growth");
  if (!["starter", "growth", "professional"].includes(planKey)) {
    return res.status(400).json({ error: "planKey must be starter, growth or professional" });
  }
  const planRow = await prisma.plan.findUnique({ where: { key: planKey } }).catch(() => null);
  const plan = planRow
    ? { ...PLAN_CATALOG[planKey], amount: planRow.amount, name: planRow.name }
    : PLAN_CATALOG[planKey];
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
  if (!payment.invoiceNo) await assignInvoiceNo(payment.id);
  emailInvoiceFor(payment);
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
  notify({
    audience: "client",
    companyId,
    title: payment.type === "wallet_recharge" ? "Wallet recharged" : "Payment successful",
    body: payment.type === "wallet_recharge" ? "Credits were added to your wallet." : `Your ${payment.plan} plan is active.`,
    href: "/dashboard/upgrade",
  }).catch(() => {});
  notify({
    audience: "admin",
    title: "New payment",
    body: `${user?.email || "Client"} · ${payment.plan}`,
    href: "/admin/payments",
  }).catch(() => {});
  res.json({ ok: true, user: publicCompanyUser(user, company) });
});

function serializeInvoice(p, company) {
  const planKey = normalizePlan(p.plan);
  const planName = PLAN_CATALOG[planKey]?.name || planKey;
  return {
    id: p.id,
    invoiceNo: p.invoiceNo,
    type: p.type,
    plan: planKey,
    planName: p.type === "wallet_recharge" ? "Wallet recharge" : planName,
    amount: p.amount,
    amountLabel: moneyInr(p.amount),
    currency: p.currency,
    status: p.status,
    razorpayPaymentId: p.razorpayPaymentId,
    paidAt: p.paidAt ? p.paidAt.getTime() : p.createdAt.getTime(),
    companyName: company?.name || null,
  };
}

router.get("/billing/invoices", requireAuth, attachCompany, async (req, res) => {
  const companyId = companyIdOf(req);
  if (!companyId) return res.json([]);
  const rows = await prisma.payment.findMany({
    where: { companyId, status: "paid" },
    orderBy: { paidAt: "desc" },
  });
  for (const p of rows) {
    if (!p.invoiceNo) p.invoiceNo = await assignInvoiceNo(p.id);
  }
  res.json(rows.map((p) => serializeInvoice(p, req.company)));
});

router.get("/billing/invoices/:id", requireAuth, attachCompany, async (req, res) => {
  const companyId = companyIdOf(req);
  if (!companyId) return res.status(403).json({ error: "No company" });
  const p = await prisma.payment.findFirst({ where: { id: req.params.id, companyId, status: "paid" } });
  if (!p) return res.status(404).json({ error: "Invoice not found" });
  if (!p.invoiceNo) p.invoiceNo = await assignInvoiceNo(p.id);
  const inv = serializeInvoice(p, req.company);
  const when = new Date(inv.paidAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${inv.invoiceNo}</title>
<style>
  body{font-family:Segoe UI,Arial,sans-serif;color:#111;max-width:720px;margin:40px auto;padding:0 24px}
  .row{display:flex;justify-content:space-between;align-items:flex-start}
  h1{font-size:22px;margin:0} table{width:100%;border-collapse:collapse;margin-top:24px}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #eee}
  .muted{color:#666;font-size:13px} .total{font-size:18px;font-weight:800}
  @media print { button{display:none} }
</style></head><body>
  <div class="row">
    <div><h1>Nexwapi</h1><p class="muted">Tax invoice</p></div>
    <div style="text-align:right"><b>${inv.invoiceNo}</b><div class="muted">${when}</div></div>
  </div>
  <p class="muted" style="margin-top:20px">Bill to<br><b>${inv.companyName || "Customer"}</b></p>
  <table>
    <thead><tr><th>Description</th><th>Payment ID</th><th>Amount</th></tr></thead>
    <tbody>
      <tr><td>${inv.planName} subscription</td><td class="muted">${inv.razorpayPaymentId || "—"}</td><td>${inv.amountLabel}</td></tr>
    </tbody>
  </table>
  <p class="total" style="text-align:right;margin-top:16px">Paid ${inv.amountLabel}</p>
  <p class="muted">This is a computer-generated invoice for Nexwapi software subscription. WhatsApp conversation charges are billed separately by Meta.</p>
  <button onclick="window.print()" style="margin-top:24px;padding:10px 16px;border:0;border-radius:8px;background:#16a34a;color:#fff;font-weight:700;cursor:pointer">Download / Print</button>
</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
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
      if (!payment.invoiceNo) await assignInvoiceNo(payment.id);
      emailInvoiceFor(payment);
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
  const auth = await requireApiKey(req, res);
  if (!auth) return;

  const { to, text, template, params, language = "en" } = req.body || {};
  if (!to) return res.status(400).json({ error: "to (phone number) required", code: "VALIDATION_ERROR" });

  const cleanPhone = digitsPhone(to);
  const existingContact = await prisma.contact.findFirst({
    where: { companyId: auth.companyId, phone: cleanPhone },
  });
  const setting = await prisma.setting.findUnique({ where: { companyId: auth.companyId } });
  const rejectOptedOut = setting?.rejectOptedOutApi !== false;
  if (rejectOptedOut && existingContact && existingContact.optedIn === false) {
    return res.status(403).json({
      error: "Contact has opted out of messaging",
      code: "OPTED_OUT",
    });
  }

  let charge = { charged: false, creditsNeeded: 0 };
  try {
    if (template) {
      charge = await templateChargeCredits(auth.companyId, template, { to, channel: "api_key" });
    }
  } catch (e) {
    return res.status(e.status || 402).json({ error: e.message, code: e.code || "NO_CREDITS" });
  }
  const creds = await getEffectiveCreds(auth.companyId);
  try {
    let result;
    if (template) {
      result = params?.length
        ? await sendTemplateWithParams(to, template, params, language, creds)
        : await sendTemplate(to, template, language, creds);
    } else if (text) {
      result = await sendText(to, text, creds);
    } else {
      return res.status(400).json({ error: "text or template required", code: "VALIDATION_ERROR" });
    }
    const contact = existingContact || await prisma.contact.findFirst({ where: { companyId: auth.companyId, phone: cleanPhone } });
    if (contact) {
      await prisma.message.create({
        data: {
          companyId: auth.companyId,
          contactId: contact.id,
          waId: result.messages?.[0]?.id || null,
          direction: "out",
          type: template ? "template" : "text",
          text: text || `[Template: ${template}]`,
          status: "sent",
        },
      });
    }
    fireEvent(auth.companyId, "message.sent", {
      to: cleanPhone,
      text: text || null,
      template: template || null,
      messageId: result.messages?.[0]?.id || null,
    }).catch(() => {});
    res.json({ ok: true, messageId: result.messages?.[0]?.id || null });
  } catch (e) {
    if (charge.charged) {
      await refundCredits(auth.companyId, charge.creditsNeeded, "api_message_refund", {
        to,
        reason: e.message,
        template: template || null,
        channel: "api_key",
      }).catch(() => {});
    }
    res.status(502).json({ error: e.message, code: "SEND_FAILED" });
  }
});

/** Account + API capability probe */
router.get("/v1/account", async (req, res) => {
  const auth = await requireApiKey(req, res);
  if (!auth) return;
  const setting = await prisma.setting.findUnique({ where: { companyId: auth.companyId } });
  res.json({
    ok: true,
    companyId: auth.companyId,
    name: auth.company?.name || null,
    plan: auth.plan,
    status: auth.company?.status || null,
    rejectOptedOutApi: setting?.rejectOptedOutApi !== false,
    webhookConfigured: Boolean(String(setting?.webhookUrl || "").trim()),
  });
});

/** List / search contacts */
router.get("/v1/contacts", async (req, res) => {
  const auth = await requireApiKey(req, res);
  if (!auth) return;
  const phone = req.query.phone ? digitsPhone(req.query.phone) : "";
  const q = String(req.query.q || "").trim();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const where = {
    companyId: auth.companyId,
    ...(phone ? { phone } : {}),
    ...(q && !phone
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q.replace(/[^\d]/g, "") } },
          ],
        }
      : {}),
  };
  const rows = await prisma.contact.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  res.json({ ok: true, contacts: rows.map(publicContact), count: rows.length });
});

/** Create or upsert contact by phone */
router.post("/v1/contacts", async (req, res) => {
  const auth = await requireApiKey(req, res);
  if (!auth) return;
  const { name, phone, email, tags, optedIn, attributes } = req.body || {};
  const cleanPhone = digitsPhone(phone);
  if (!cleanPhone) return res.status(400).json({ error: "phone required", code: "VALIDATION_ERROR" });
  const displayName = String(name || "").trim() || `+${cleanPhone}`;
  const data = {
    name: displayName,
    email: email ? String(email).toLowerCase().trim() : null,
    ...(tags !== undefined ? { tags: Array.isArray(tags) ? tags.map(String) : [] } : {}),
    ...(optedIn !== undefined ? { optedIn: Boolean(optedIn) } : {}),
    ...(attributes !== undefined && typeof attributes === "object" ? { attributes } : {}),
  };
  const contact = await prisma.contact.upsert({
    where: { companyId_phone: { companyId: auth.companyId, phone: cleanPhone } },
    create: { companyId: auth.companyId, phone: cleanPhone, ...data, optedIn: optedIn !== undefined ? Boolean(optedIn) : true },
    update: data,
  });
  res.status(201).json({ ok: true, contact: publicContact(contact) });
});

/** Update opt-in by phone */
router.patch("/v1/contacts/:phone/opt-in", async (req, res) => {
  const auth = await requireApiKey(req, res);
  if (!auth) return;
  const cleanPhone = digitsPhone(req.params.phone);
  const optedIn = req.body?.optedIn;
  if (typeof optedIn !== "boolean") {
    return res.status(400).json({ error: "optedIn boolean required", code: "VALIDATION_ERROR" });
  }
  const existing = await prisma.contact.findFirst({ where: { companyId: auth.companyId, phone: cleanPhone } });
  if (!existing) return res.status(404).json({ error: "Contact not found", code: "NOT_FOUND" });
  const contact = await prisma.contact.update({
    where: { id: existing.id },
    data: { optedIn },
  });
  res.json({ ok: true, contact: publicContact(contact) });
});

/** List sendable (approved) templates */
router.get("/v1/templates", async (req, res) => {
  const auth = await requireApiKey(req, res);
  if (!auth) return;
  const templates = await prisma.template.findMany({
    where: {
      companyId: auth.companyId,
      deletedAt: null,
      status: { in: ["approved", "APPROVED", "active"] },
    },
    orderBy: { name: "asc" },
    take: 200,
  });
  res.json({
    ok: true,
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      language: t.language || "en",
      category: t.category || null,
      status: String(t.status || "").toLowerCase(),
    })),
  });
});

/** Track a contact event (Interakt-style Event API). Auth via x-api-key. */
router.post("/v1/events", apiMessageLimiter, async (req, res) => {
  const auth = await requireApiKey(req, res);
  if (!auth) return;
  try {
    const body = req.body || {};
    const { trackContactEvent } = await import("../lib/customEvents.js");
    const result = await trackContactEvent(auth.companyId, {
      event: body.event || body.eventName || body.name,
      phone: body.phone || body.phone_number || body.to,
      userId: body.userId || body.user_id,
      traits: body.traits || body.properties || {},
    });
    res.json(result);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code || "ERROR" });
    throw e;
  }
});

router.post("/sales-leads", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").toLowerCase().trim();
  const phone = String(req.body?.phone || "").trim();
  const company = String(req.body?.company || "").trim();
  const message = String(req.body?.message || "").trim();
  if (!name || !email || !message) {
    return res.status(400).json({ error: "name, email and message are required" });
  }
  const lead = await prisma.salesLead.create({
    data: { name, email, phone, company, message },
  });
  notify({
    audience: "admin",
    title: "New Talk to Sales lead",
    body: `${name} (${email})${company ? " · " + company : ""}`,
    href: "/admin/sales",
  }).catch(() => {});
  res.status(201).json({ ok: true, id: lead.id });
});

/* -------- Public integration webhooks (no JWT — verified by companyId + secret) -------- */
router.get("/integrations/hooks/facebook_leads/:companyId", (req, res) => {
  // Meta webhook verification
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = process.env.WHATSAPP_VERIFY_TOKEN || process.env.FB_LEADS_VERIFY_TOKEN || "nexwapi_leads";
  if (mode === "subscribe" && token === expected) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

router.post("/integrations/hooks/:provider/:companyId", async (req, res) => {
  const provider = String(req.params.provider || "");
  const companyId = String(req.params.companyId || "");
  try {
    await resolveHookCompany(provider, companyId, req);
    let result = { ok: true };
    if (provider === "woocommerce") {
      const topic = req.headers["x-wc-webhook-topic"] || req.query.topic || "order";
      result = await handleWooWebhook(companyId, String(topic), req.body || {});
    } else if (provider === "shopify") {
      const topic = req.headers["x-shopify-topic"] || req.query.topic || "orders/create";
      result = await handleShopifyWebhook(companyId, String(topic), req.body || {});
    } else if (provider === "google_sheets") {
      result = await handleGoogleSheetRow(companyId, req.body || {});
    } else if (provider === "facebook_leads") {
      // Meta sends entry[].changes[].value
      const entry = req.body?.entry || [];
      for (const e of entry) {
        for (const change of e.changes || []) {
          if (change.field === "leadgen") {
            await handleFacebookLead(companyId, change.value || {});
          }
        }
      }
      // Also accept direct flattened leads
      if (!entry.length) result = await handleFacebookLead(companyId, req.body || {});
    } else {
      return res.status(404).json({ error: "Unknown provider" });
    }
    res.json(result);
  } catch (e) {
    console.error("[integrations hook]", provider, e?.message || e);
    res.status(e.status || 400).json({ error: e?.message || "Webhook failed" });
  }
});

router.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
router.use(requireAuth);
router.use(attachCompany);

function outboundTextWithAgent(req, text) {
  const raw = String(text || "");
  const name = String(req.user?.name || "").trim();
  const role = String(req.user?.role || "");
  if (name && (role === "AGENT" || role === "Agent")) return `*${name}:*\n${raw}`;
  return raw;
}

router.get("/notifications", async (req, res) => {
  const isAdmin = req.user?.role === "SUPER_ADMIN";
  const where = isAdmin
    ? { audience: "admin", OR: [{ userId: req.user.id }, { userId: null }] }
    : {
        audience: "client",
        OR: [
          { userId: req.user.id },
          { companyId: companyIdOf(req), userId: null },
        ],
      };
  const rows = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json(rows.map((n) => ({ ...n, createdAt: n.createdAt.getTime() })));
});

router.patch("/notifications/:id/read", async (req, res) => {
  const n = await prisma.notification.updateMany({
    where: { id: req.params.id, OR: [{ userId: req.user.id }, { userId: null, companyId: companyIdOf(req) }, { userId: null, audience: "admin" }] },
    data: { read: true },
  });
  if (!n.count) return res.sendStatus(404);
  res.json({ ok: true });
});

router.post("/notifications/read-all", async (req, res) => {
  const isAdmin = req.user?.role === "SUPER_ADMIN";
  await prisma.notification.updateMany({
    where: isAdmin
      ? { audience: "admin", read: false, OR: [{ userId: req.user.id }, { userId: null }] }
      : { audience: "client", read: false, OR: [{ userId: req.user.id }, { companyId: companyIdOf(req), userId: null }] },
    data: { read: true },
  });
  res.json({ ok: true });
});

router.delete("/me", async (req, res) => {
  if (!(await otpGate(req, res, "account_delete"))) return;
  const role = String(req.user?.role || "");
  if (role === "SUPER_ADMIN") return res.status(400).json({ error: "Super Admin accounts cannot be deleted here" });
  if (role !== "AGENT" && role !== "Agent") {
    return res.status(400).json({ error: "Only agent profiles can be deleted from settings. Ask an owner to remove other seats." });
  }
  const email = req.user.email;
  const companyId = companyIdOf(req);
  await prisma.agent.deleteMany({ where: { email, companyId } }).catch(() => {});
  await prisma.user.delete({ where: { id: req.user.id } });
  res.json({ ok: true });
});

/* ------------------------------ Contacts ------------------------------- */
router.get("/contacts", async (req, res) => {
  if (!(await userHasWorkspacePermission(req, "contacts.access"))) {
    return res.status(403).json({ error: "You do not have permission for this action", code: "PERMISSION_DENIED", permission: "contacts.access" });
  }
  const { permissions } = await resolveWorkspaceRole(req);
  const contacts = await prisma.contact.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(contacts.map((c) => {
    const row = { ...c, createdAt: c.createdAt.getTime() };
    if (permissions["contacts.hide_fields"]) {
      return { ...row, phone: "••••••••••", email: null, attributes: {}, tags: row.tags || [] };
    }
    if (permissions["contacts.hide_phone"] || permissions["contacts.hide_phone_legacy"]) {
      return { ...row, phone: "••••••••••" };
    }
    return row;
  }));
});

router.post("/contacts", async (req, res) => {
  if (!(await userHasWorkspacePermission(req, "contacts.add"))) {
    return res.status(403).json({ error: "You do not have permission for this action", code: "PERMISSION_DENIED", permission: "contacts.add" });
  }
  const { name, phone, tags = [], email, userId, optedIn, attributes } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "name and phone required" });
  const cleanPhone = digitsOnly(phone);
  const companyId = companyIdOf(req);
  const tagList = Array.isArray(tags) ? tags : String(tags).split(",").map((t) => t.trim()).filter(Boolean);
  const existing = await findCompanyContactByPhone(prisma, companyId, cleanPhone);
  const attrData = attributes && typeof attributes === "object" ? attributes : {};
  if (existing) {
    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: {
        name: String(name).trim(),
        ...(tagList.length ? { tags: tagList } : {}),
        ...(email !== undefined ? { email: email ? String(email).trim() : null } : {}),
        ...(userId !== undefined ? { userId: userId ? String(userId).trim() : null } : {}),
        ...(optedIn !== undefined ? { optedIn: Boolean(optedIn) } : {}),
        ...(Object.keys(attrData).length ? { attributes: { ...(existing.attributes || {}), ...attrData } } : {}),
      },
    });
    return res.json({ ...contact, createdAt: contact.createdAt.getTime() });
  }
  const count = await prisma.contact.count({ where: tenantWhere(req) });
  try {
    const contact = await prisma.contact.create({
      data: {
        companyId,
        name: String(name).trim(),
        phone: cleanPhone,
        tags: tagList,
        email: email ? String(email).trim() : null,
        userId: userId ? String(userId).trim() : null,
        optedIn: optedIn !== undefined ? Boolean(optedIn) : true,
        attributes: attrData,
        color: pickColor(count),
      },
    });
    res.status(201).json({ ...contact, createdAt: contact.createdAt.getTime() });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Contact with this number already exists" });
    throw e;
  }
});

router.patch("/contacts/:id", async (req, res) => {
  const existing = await tenantContact(req, req.params.id);
  if (!existing) return res.status(404).json({ error: "Contact not found" });
  const data = {};
  if (req.body?.name != null) data.name = String(req.body.name).trim();
  if (req.body?.phone != null) {
    const newPhone = String(req.body.phone).replace(/[^\d]/g, "");
    if (newPhone !== existing.phone) {
      data.phone = newPhone;
      logActivity(existing.id, "phone_updated", `Phone updated to +${newPhone}`);
    }
  }
  if (req.body?.tags != null) {
    data.tags = Array.isArray(req.body.tags)
      ? req.body.tags
      : String(req.body.tags).split(",").map((t) => t.trim()).filter(Boolean);
  }
  if (req.body?.optedIn != null) data.optedIn = Boolean(req.body.optedIn);
  if (req.body?.email !== undefined) data.email = req.body.email ? String(req.body.email).trim() : null;
  if (req.body?.userId !== undefined) data.userId = req.body.userId ? String(req.body.userId).trim() : null;
  if (req.body?.attributes != null && typeof req.body.attributes === "object") {
    data.attributes = { ...(existing.attributes || {}), ...req.body.attributes };
  }
  try {
    const contact = await prisma.contact.update({ where: { id: existing.id }, data });
    res.json({ ...contact, createdAt: contact.createdAt.getTime() });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Another contact already uses this number" });
    throw e;
  }
});

router.delete("/contacts/:id", async (req, res) => {
  try {
    if (!(await userHasWorkspacePermission(req, "contacts.delete"))) {
      return res.status(403).json({ error: "You do not have permission for this action", code: "PERMISSION_DENIED", permission: "contacts.delete" });
    }
    const gate = await requireOtpOrSkip(req.user.email, "contact_delete", req.body?.otp || req.query?.otp);
    if (gate.otpRequired) return res.json({ otpRequired: true });
    if (!gate.ok) return res.status(400).json({ error: gate.error || "Invalid OTP" });
    const deleted = await prisma.contact.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

// Bulk import contacts (from a parsed CSV). Skips invalid rows and duplicates.
router.post("/contacts/import", async (req, res) => {
  if (!(await userHasWorkspacePermission(req, "contacts.add"))) {
    return res.status(403).json({ error: "You do not have permission for this action", code: "PERMISSION_DENIED", permission: "contacts.add" });
  }
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
    const attrData = c.attributes && typeof c.attributes === "object" ? c.attributes : {};
    const existing = await findCompanyContactByPhone(prisma, companyIdOf(req), phone);
    try {
      if (existing) {
        await prisma.contact.update({
          where: { id: existing.id },
          data: {
            name: String(c.name).trim(),
            ...(tags.length ? { tags } : {}),
            ...(c.email !== undefined ? { email: c.email ? String(c.email).trim() : null } : {}),
            ...(c.userId !== undefined ? { userId: c.userId ? String(c.userId).trim() : null } : {}),
            ...(c.optedIn !== undefined ? { optedIn: Boolean(c.optedIn) } : {}),
            ...(Object.keys(attrData).length ? { attributes: { ...(existing.attributes || {}), ...attrData } } : {}),
          },
        });
      } else {
        await prisma.contact.create({
          data: {
            companyId: companyIdOf(req),
            name: String(c.name).trim(),
            phone,
            tags,
            email: c.email ? String(c.email).trim() : null,
            userId: c.userId ? String(c.userId).trim() : null,
            optedIn: c.optedIn !== undefined ? Boolean(c.optedIn) : true,
            attributes: attrData,
            color: pickColor(start + added),
          },
        });
      }
      added++;
    } catch {
      skipped++;
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
  const { originalname, mimetype, filename, path: tmpPath } = req.file;
  const storedName = filename + (path.extname(originalname) || "");
  fs.renameSync(tmpPath, path.join(UPLOAD_DIR, storedName));
  const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${storedName}`;
  const waType = waMediaType(mimetype);
  const caption = req.body?.caption || "";
  const creds = await getEffectiveCreds(companyId);

  let waId = null;
  try {
    const mediaId = await uploadMedia(fs.readFileSync(path.join(UPLOAD_DIR, storedName)), mimetype, originalname, creds);
    if (mediaId) {
      const r = await sendMediaById(contact.phone, waType, mediaId, { filename: originalname, caption }, creds);
      waId = r.messages?.[0]?.id || null;
    }
  } catch (e) {
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
    const c = await prisma.contact.update({ where: { id: existing.id }, data: { chatStatus: status, ...(status === "resolved" ? {} : {}) } });
    fireEvent(companyIdOf(req), "chat.status", { name: c.name, phone: c.phone, status }).catch(() => {});
    logActivity(c.id, "status", `Chat marked ${status}`);

    if (status === "open" && existing.chatStatus === "resolved") {
      await assignContactToAgent(c, companyIdOf(req), { force: true }).catch(() => {});
    }

    // On resolve, optionally send a CSAT rating request.
    if (status === "resolved") {
      const s = await prisma.setting.findUnique({ where: { companyId: companyIdOf(req) } });
      if (s?.csatEnabled) {
        try {
          const creds = await getEffectiveCreds(companyIdOf(req));
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
function serializeQuickReply(q) {
  return {
    id: q.id,
    title: q.title,
    name: q.title,
    text: q.text,
    message: q.text,
    createdBy: q.createdBy || "",
    createdAt: q.createdAt instanceof Date ? q.createdAt.getTime() : q.createdAt,
    updatedAt: q.updatedAt instanceof Date ? q.updatedAt.getTime() : q.updatedAt,
  };
}

router.get("/quick-replies", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const items = await prisma.quickReply.findMany({
    where: {
      ...tenantWhere(req),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { text: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(items.map(serializeQuickReply));
});

router.post("/quick-replies", async (req, res) => {
  const title = String(req.body?.title || req.body?.name || "").trim();
  const text = String(req.body?.text || req.body?.message || "").trim();
  if (!title || !text) return res.status(400).json({ error: "name and message required" });
  if (text.length > 4000) return res.status(400).json({ error: "Message max 4000 characters" });
  const q = await prisma.quickReply.create({
    data: {
      companyId: companyIdOf(req),
      title,
      text,
      createdBy: req.user?.name || req.user?.email || "",
    },
  });
  res.status(201).json(serializeQuickReply(q));
});

router.patch("/quick-replies/:id", async (req, res) => {
  const existing = await prisma.quickReply.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  const title = req.body?.title != null || req.body?.name != null
    ? String(req.body?.title || req.body?.name || "").trim()
    : existing.title;
  const text = req.body?.text != null || req.body?.message != null
    ? String(req.body?.text || req.body?.message || "").trim()
    : existing.text;
  if (!title || !text) return res.status(400).json({ error: "name and message required" });
  if (text.length > 4000) return res.status(400).json({ error: "Message max 4000 characters" });
  const q = await prisma.quickReply.update({
    where: { id: existing.id },
    data: { title, text },
  });
  res.json(serializeQuickReply(q));
});

router.delete("/quick-replies/:id", async (req, res) => {
  try {
    // OTP optional: if body/query has otpRequired flow from inbox; settings page may skip
    if (req.body?.otp !== undefined || req.query?.otp !== undefined) {
      if (!(await otpGate(req, res, "quick_reply_delete"))) return;
    }
    const deleted = await prisma.quickReply.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------------- Agents -------------------------------- */
router.get("/agents", async (req, res) => {
  const companyId = companyIdOf(req);
  const agents = await listAgentsEnriched(companyId);
  res.json(agents);
});

router.get("/agent-settings", async (req, res) => {
  const companyId = companyIdOf(req);
  const [agents, seats, teams] = await Promise.all([
    listAgentsEnriched(companyId),
    companySeatUsage(companyId),
    prisma.team.findMany({ where: { companyId }, orderBy: { name: "asc" } }),
  ]);
  res.json({
    agents,
    seats: {
      used: seats.used,
      limit: seats.unlimited ? null : seats.limit,
      unlimited: seats.unlimited,
      salesUsed: seats.salesUsed,
      salesLimit: seats.unlimited ? null : seats.salesLimit,
    },
    teams: teams.map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt.getTime() })),
    roles: AGENT_ROLES,
  });
});

router.post("/agents", async (req, res) => {
  const {
    name,
    firstName,
    lastName,
    email,
    phone,
    role = "Teammate",
    teamId,
    otp,
    password,
  } = req.body || {};
  if ((!name && !firstName) || !email) {
    return res.status(400).json({ error: "name/firstName and email required" });
  }
  const gate = await requireOtpOrSkip(req.user.email, "user_add", otp);
  if (gate.otpRequired) return res.json({ otpRequired: true });
  if (!gate.ok) return res.status(400).json({ error: gate.error || "Invalid OTP" });
  try {
    const { agent, login } = await createAgentSeat(companyIdOf(req), {
      name,
      firstName,
      lastName,
      email,
      phone,
      role,
      teamId: teamId || null,
      password,
      createdBy: req.user?.name || req.user?.email || "",
    });
    if (login?.password) {
      const { sendAgentInvite } = await import("../lib/mailer.js");
      sendAgentInvite({
        to: login.email,
        name: agent.name,
        inviterName: req.user?.name || "Your teammate",
        password: login.password,
        role: agent.role,
      }).catch((e) => console.warn("[agents] invite email:", e?.message || e));
    }
    res.status(201).json({
      ...agent,
      loginEmail: login.email,
      tempPassword: login.password,
      inviteEmailSent: Boolean(login?.password),
    });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Agent with this email already exists" });
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code, limit: e.limit, used: e.used });
    throw e;
  }
});

router.patch("/agents/:id", async (req, res) => {
  try {
    const updated = await updateAgentSeat(companyIdOf(req), req.params.id, req.body || {});
    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

router.post("/agents/:id/resend-invitation", async (req, res) => {
  try {
    const gate = await requireOtpOrSkip(req.user.email, "user_add", req.body?.otp);
    if (gate.otpRequired) return res.json({ otpRequired: true });
    if (!gate.ok) return res.status(400).json({ error: gate.error || "Invalid OTP" });
    const invite = await resetAgentInvitePassword(companyIdOf(req), req.params.id);
    const { sendAgentInvite } = await import("../lib/mailer.js");
    await sendAgentInvite({
      to: invite.email,
      name: invite.name,
      inviterName: req.user?.name || "Your teammate",
      password: invite.password,
      role: "Teammate",
    }).catch(() => {});
    res.json({ ok: true, email: invite.email, tempPassword: invite.password });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(502).json({ error: e?.message || "Could not resend invitation" });
  }
});

router.delete("/agents/:id", async (req, res) => {
  try {
    const gate = await requireOtpOrSkip(req.user.email, "user_delete", req.body?.otp || req.query?.otp);
    if (gate.otpRequired) return res.json({ otpRequired: true });
    if (!gate.ok) return res.status(400).json({ error: gate.error || "Invalid OTP" });
    const agent = await prisma.agent.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (!agent) return res.sendStatus(404);
    if (agent.role === "Owner") return res.status(400).json({ error: "Owner cannot be deleted" });
    await prisma.contact.updateMany({ where: { assignedAgentId: agent.id, ...tenantWhere(req) }, data: { assignedAgentId: null } });
    await prisma.agent.delete({ where: { id: agent.id } });
    await prisma.user.deleteMany({ where: { email: agent.email, companyId: companyIdOf(req), role: { in: ["AGENT", "ADMIN", "MEMBER"] } } }).catch(() => {});
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

router.patch("/agents/:id/availability", async (req, res) => {
  const { availability } = req.body || {};
  const allowed = ["online", "away", "offline"];
  if (!allowed.includes(availability)) return res.status(400).json({ error: "availability must be online, away, or offline" });
  try {
    const updated = await updateAgentSeat(companyIdOf(req), req.params.id, { availability });
    res.json(updated);
  } catch (e) {
    if (e.status === 404) return res.sendStatus(404);
    throw e;
  }
});

/* ------------------------------- Teams --------------------------------- */
router.get("/teams", async (req, res) => {
  const { listTeamsDetailed } = await import("../lib/teams.js");
  const teams = await listTeamsDetailed(companyIdOf(req), { q: req.query.q });
  res.json(teams);
});

router.get("/teams/controls", async (req, res) => {
  const { getTeamControls } = await import("../lib/teams.js");
  res.json(await getTeamControls(companyIdOf(req)));
});

router.patch("/teams/controls", async (req, res) => {
  const { updateTeamControls } = await import("../lib/teams.js");
  res.json(await updateTeamControls(companyIdOf(req), req.body || {}));
});

router.get("/teams/:id", async (req, res) => {
  const { getTeamDetailed } = await import("../lib/teams.js");
  const team = await getTeamDetailed(companyIdOf(req), req.params.id);
  if (!team) return res.status(404).json({ error: "Team not found" });
  res.json(team);
});

router.post("/teams", async (req, res) => {
  try {
    const { upsertTeamMembers } = await import("../lib/teams.js");
    const team = await upsertTeamMembers(companyIdOf(req), null, {
      name: req.body?.name,
      leadIds: req.body?.leadIds || [],
      memberIds: req.body?.memberIds || req.body?.agentIds || [],
    });
    res.status(201).json(team);
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Team already exists" });
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

router.patch("/teams/:id", async (req, res) => {
  try {
    const { upsertTeamMembers } = await import("../lib/teams.js");
    const team = await upsertTeamMembers(companyIdOf(req), req.params.id, {
      name: req.body?.name,
      leadIds: req.body?.leadIds,
      memberIds: req.body?.memberIds ?? req.body?.agentIds,
    });
    res.json(team);
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Team already exists" });
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

router.delete("/teams/:id", async (req, res) => {
  const existing = await prisma.team.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!existing) return res.sendStatus(404);
  await prisma.agent.updateMany({ where: { teamId: existing.id }, data: { teamId: null } });
  await prisma.team.delete({ where: { id: existing.id } });
  res.sendStatus(204);
});

/* ------------------------- Role permissions (RBAC) --------------------- */
router.get("/role-permissions", async (req, res) => {
  const rbac = await resolveWorkspaceRole(req);
  const allowed =
    ["Owner", "Admin", "Super Admin"].includes(rbac.role) ||
    rbac.permissions?.["settings.agents"] === true;
  if (!allowed) {
    return res.status(403).json({ error: "You do not have permission to manage role permissions", code: "PERMISSION_DENIED" });
  }
  const data = await getAllRolePermissions(companyIdOf(req));
  res.json(data);
});

router.get("/role-permissions/:role", async (req, res) => {
  const data = await getAllRolePermissions(companyIdOf(req));
  const role = req.params.role;
  if (!data.roles[role]) return res.status(404).json({ error: "Unknown role" });
  res.json({ role, permissions: data.roles[role], catalog: data.catalog });
});

router.put("/role-permissions/:role", async (req, res) => {
  const rbac = await resolveWorkspaceRole(req);
  if (rbac.role !== "Owner" && rbac.role !== "Admin" && rbac.role !== "Super Admin") {
    if (!(await userHasWorkspacePermission(req, "settings.agents"))) {
      return res.status(403).json({ error: "Only Owner/Admin can edit role permissions", code: "PERMISSION_DENIED" });
    }
  }
  try {
    const permissions = await saveRolePermissions(companyIdOf(req), req.params.role, req.body?.permissions || req.body || {});
    res.json({ ok: true, role: req.params.role, permissions });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

router.post("/role-permissions/:role/reset", async (req, res) => {
  const rbac = await resolveWorkspaceRole(req);
  if (rbac.role !== "Owner" && rbac.role !== "Admin" && rbac.role !== "Super Admin") {
    return res.status(403).json({ error: "Only Owner/Admin can reset role permissions", code: "PERMISSION_DENIED" });
  }
  const { defaultPermissionsForRole } = await import("../lib/rolePermissions.js");
  const permissions = await saveRolePermissions(companyIdOf(req), req.params.role, defaultPermissionsForRole(req.params.role));
  res.json({ ok: true, role: req.params.role, permissions });
});

/* ------------------------ Basic inbox automations ---------------------- */
router.get("/automation/inbox", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const data = await getInboxAutomationSettings(companyId);
  res.json({
    ...data,
    workingHoursSummary: formatWorkingHoursSummary(data),
    workingHoursSlots: data.workingHoursSlots?.length ? data.workingHoursSlots : defaultWorkingHoursSlots(),
  });
}));

router.patch("/automation/inbox", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const updated = await updateInboxAutomationSettings(companyId, req.body, req.company?.name);
  res.json({
    ...updated,
    workingHoursSummary: formatWorkingHoursSummary(updated),
    workingHoursSlots: updated.workingHoursSlots?.length ? updated.workingHoursSlots : defaultWorkingHoursSlots(),
  });
}));

router.get("/automation/custom-replies", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const [items, setting, wa] = await Promise.all([
    prisma.automation.findMany({ where: { companyId }, orderBy: { updatedAt: "desc" } }),
    prisma.setting.findUnique({ where: { companyId } }),
    prisma.whatsAppAccount.findFirst({ where: { companyId, isDefault: true } }),
  ]);
  const totalSent = items.reduce((s, a) => s + (a.sentCount || 0), 0);
  res.json({
    customRepliesEnabled: setting?.customRepliesEnabled !== false,
    intentMatchingEnabled: Boolean(setting?.intentMatchingEnabled),
    whatsappConnected: Boolean(wa?.isConnected),
    totalSent,
    items: items.map((a) => ({
      ...a,
      actionType: "Send Message",
      createdAt: a.createdAt.getTime(),
      updatedAt: a.updatedAt.getTime(),
    })),
  });
}));

router.patch("/automation/custom-replies/settings", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { customRepliesEnabled } = req.body || {};
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: { ...(customRepliesEnabled !== undefined && { customRepliesEnabled: Boolean(customRepliesEnabled) }) },
    create: { companyId, businessName: req.company?.name || "Nexwapi", customRepliesEnabled: customRepliesEnabled !== false },
  });
  res.json({ customRepliesEnabled: s.customRepliesEnabled !== false });
}));

/* ------------------------ Conversation routing ------------------------- */
router.get("/assignment/meta", async (_req, res) => {
  res.json({ traits: CONTACT_TRAITS, conditions: TRAIT_CONDITIONS });
});

router.get("/assignment/settings", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  res.json(await getAssignmentSettings(companyId));
}));

router.patch("/assignment/settings", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { assignmentMode, autoAssign, assignOnlineOnly } = req.body || {};
  const data = {};
  if (assignmentMode !== undefined) {
    const allowed = ["none", "round_robin", "load_balance"];
    if (!allowed.includes(String(assignmentMode))) {
      return res.status(400).json({ error: "Invalid assignment mode" });
    }
    data.assignmentMode = String(assignmentMode);
    data.autoAssign = assignmentMode !== "none";
    if (assignmentMode === "round_robin") data.roundRobinIndex = 0;
  }
  if (autoAssign !== undefined) data.autoAssign = Boolean(autoAssign);
  if (assignOnlineOnly !== undefined) data.assignOnlineOnly = Boolean(assignOnlineOnly);

  const s = await prisma.setting.upsert({
    where: { companyId },
    update: data,
    create: { companyId, businessName: req.company?.name || "Nexwapi", ...data },
  });
  res.json({
    ...(await getAssignmentSettings(companyId)),
    setting: {
      assignmentMode: s.assignmentMode,
      autoAssign: s.autoAssign,
      assignOnlineOnly: s.assignOnlineOnly,
    },
  });
}));

router.get("/assignment/rules", asyncRoute(async (req, res) => {
  const rules = await prisma.assignmentRule.findMany({
    where: tenantWhere(req),
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  res.json(rules.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })));
}));

router.post("/assignment/rules", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { name, trait, condition, values, agentIds, enabled = true, priority = 0 } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "Rule name is required" });
  if (!trait) return res.status(400).json({ error: "Contact field is required" });
  if (!Array.isArray(values) || !values.length) return res.status(400).json({ error: "At least one value is required" });
  if (!Array.isArray(agentIds) || !agentIds.length) return res.status(400).json({ error: "Select at least one agent" });
  const agents = await prisma.agent.findMany({ where: { id: { in: agentIds }, companyId } });
  if (agents.length !== agentIds.length) return res.status(400).json({ error: "One or more agents not found" });
  const rule = await prisma.assignmentRule.create({
    data: {
      companyId,
      name: name.trim(),
      trait,
      condition: condition || "contains",
      values: values.map(String),
      agentIds,
      enabled: Boolean(enabled),
      priority: Number(priority) || 0,
    },
  });
  res.status(201).json({ ...rule, createdAt: rule.createdAt.getTime() });
}));

router.patch("/assignment/rules/:id", async (req, res) => {
  const companyId = companyIdOf(req);
  const existing = await prisma.assignmentRule.findFirst({ where: { id: req.params.id, companyId } });
  if (!existing) return res.sendStatus(404);
  const { name, trait, condition, values, agentIds, enabled, priority } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = String(name).trim();
  if (trait !== undefined) data.trait = trait;
  if (condition !== undefined) data.condition = condition;
  if (values !== undefined) {
    if (!Array.isArray(values) || !values.length) return res.status(400).json({ error: "At least one value is required" });
    data.values = values.map(String);
  }
  if (agentIds !== undefined) {
    if (!Array.isArray(agentIds) || !agentIds.length) return res.status(400).json({ error: "Select at least one agent" });
    const agents = await prisma.agent.findMany({ where: { id: { in: agentIds }, companyId } });
    if (agents.length !== agentIds.length) return res.status(400).json({ error: "One or more agents not found" });
    data.agentIds = agentIds;
  }
  if (enabled !== undefined) data.enabled = Boolean(enabled);
  if (priority !== undefined) data.priority = Number(priority) || 0;
  const rule = await prisma.assignmentRule.update({ where: { id: existing.id }, data });
  res.json({ ...rule, createdAt: rule.createdAt.getTime() });
});

router.delete("/assignment/rules/:id", async (req, res) => {
  const existing = await prisma.assignmentRule.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!existing) return res.sendStatus(404);
  await prisma.assignmentRule.delete({ where: { id: existing.id } });
  res.sendStatus(204);
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
    if (!(await otpGate(req, res, "note_delete"))) return;
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
  const { name, price = "", description = "", imageUrl = "", retailerId = "" } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const product = await prisma.product.create({
    data: {
      companyId: companyIdOf(req),
      name,
      price,
      description,
      imageUrl,
      retailerId: retailerId || "",
      source: "local",
    },
  });
  res.status(201).json({ ...product, createdAt: product.createdAt.getTime() });
});

router.delete("/products/:id", async (req, res) => {
  try {
    if (!(await otpGate(req, res, "product_delete"))) return;
    const deleted = await prisma.product.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------ WhatsApp Commerce ---------------------------- */
router.get("/commerce/overview", async (req, res) => {
  try {
    const data = await commerceOverview(companyIdOf(req));
    res.json(data);
  } catch (e) {
    console.error("[commerce overview]", e?.message || e);
    res.status(500).json({ error: commerceUserError(e) });
  }
});

router.get("/commerce/checkout-bot", async (req, res) => {
  try {
    const data = await checkoutBotOverview(companyIdOf(req));
    res.json(data);
  } catch (e) {
    console.error("[checkout-bot]", e?.message || e);
    res.status(500).json({ error: commerceUserError(e) });
  }
});

router.post("/commerce/checkout-bot/go-live", async (req, res) => {
  try {
    const cid = companyIdOf(req);
    const setting = await getOrCreateCommerceSetting(cid);
    if (!setting.shippingConfirmed || !setting.discountsConfirmed || !setting.paymentConfirmed) {
      return res.status(400).json({
        error: "Complete mandatory steps first: Shipping Cost, Discounts, and Payment Options.",
      });
    }
    const updated = await prisma.commerceSetting.update({
      where: { companyId: cid },
      data: { autocheckoutEnabled: true },
    });
    res.json({
      ok: true,
      setting: {
        ...updated,
        connectedAt: updated.connectedAt?.getTime?.() || null,
        lastSyncAt: updated.lastSyncAt?.getTime?.() || null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: commerceUserError(e) });
  }
});

router.post("/commerce/checkout-bot/pause", async (req, res) => {
  try {
    const cid = companyIdOf(req);
    await getOrCreateCommerceSetting(cid);
    const updated = await prisma.commerceSetting.update({
      where: { companyId: cid },
      data: { autocheckoutEnabled: false },
    });
    res.json({ ok: true, setting: updated });
  } catch (e) {
    res.status(500).json({ error: commerceUserError(e) });
  }
});

router.patch("/commerce/settings", async (req, res) => {
  try {
    const cid = companyIdOf(req);
    await getOrCreateCommerceSetting(cid);
    const allowed = [
      "collectionsBody", "collectionsButton", "catalogInCampaigns", "catalogInAutoReplies",
      "autocheckoutEnabled", "autocheckoutFlowId", "paymentLinkBase",
      "shippingPrompt", "paymentPrompt", "orderConfirmMessage", "partnerAccessGranted",
      "shippingMode", "shippingAmount", "freeShippingAbove",
      "discountEnabled", "discountType", "discountValue", "paymentMethod",
      "proceedMessage", "askNameMessage", "askPincodeMessage", "askAddressMessage",
      "confirmOrderMessage", "cancelMessage",
      "shippingConfirmed", "discountsConfirmed", "paymentConfirmed",
    ];
    const data = {};
    for (const k of allowed) {
      if (req.body?.[k] !== undefined) data[k] = req.body[k];
    }
    const setting = await prisma.commerceSetting.update({ where: { companyId: cid }, data });
    res.json({
      ...setting,
      connectedAt: setting.connectedAt?.getTime?.() || null,
      lastSyncAt: setting.lastSyncAt?.getTime?.() || null,
    });
  } catch (e) {
    console.error("[commerce settings]", e?.message || e);
    res.status(500).json({ error: commerceUserError(e) });
  }
});

router.post("/commerce/connect-catalog", async (req, res) => {
  try {
    const setting = await connectCatalog(companyIdOf(req), req.body?.catalogId);
    res.json({
      ok: true,
      setting: {
        ...setting,
        connectedAt: setting.connectedAt?.getTime?.() || null,
        lastSyncAt: setting.lastSyncAt?.getTime?.() || null,
      },
    });
  } catch (e) {
    console.error("[commerce connect]", e?.message || e);
    res.status(e.status || 400).json({ error: commerceUserError(e) });
  }
});

router.post("/commerce/sync", async (req, res) => {
  try {
    const result = await syncCatalog(companyIdOf(req));
    res.json(result);
  } catch (e) {
    console.error("[commerce sync]", e?.message || e);
    res.status(e.status || 400).json({ error: commerceUserError(e) });
  }
});

router.patch("/commerce/collections/:id", async (req, res) => {
  const cid = companyIdOf(req);
  const existing = await prisma.catalogCollection.findFirst({ where: { id: req.params.id, companyId: cid } });
  if (!existing) return res.status(404).json({ error: "Collection not found" });
  const { includeInTop10, headerText, bodyText, footerText, name } = req.body || {};
  const updated = await prisma.catalogCollection.update({
    where: { id: existing.id },
    data: {
      ...(includeInTop10 !== undefined ? { includeInTop10: Boolean(includeInTop10) } : {}),
      ...(headerText !== undefined ? { headerText: String(headerText) } : {}),
      ...(bodyText !== undefined ? { bodyText: String(bodyText) } : {}),
      ...(footerText !== undefined ? { footerText: String(footerText) } : {}),
      ...(name !== undefined ? { name: String(name) } : {}),
    },
  });
  res.json({
    ...updated,
    productRetailerIds: Array.isArray(updated.productRetailerIds) ? updated.productRetailerIds : [],
    createdAt: updated.createdAt.getTime(),
    updatedAt: updated.updatedAt.getTime(),
  });
});

router.post("/commerce/products/csv", async (req, res) => {
  try {
    const csv = req.body?.csv || req.body?.content || "";
    const rows = await parseProductsCsv(csv);
    if (!rows.length) return res.status(400).json({ error: "No products found in CSV. Need header: name,price,description,image_url,retailer_id" });
    const cid = companyIdOf(req);
    const created = [];
    for (const row of rows) {
      const p = await prisma.product.create({ data: { companyId: cid, ...row } });
      created.push({ ...p, createdAt: p.createdAt.getTime() });
    }
    await getOrCreateCommerceSetting(cid);
    res.status(201).json({ ok: true, count: created.length, products: created });
  } catch (e) {
    res.status(400).json({ error: e?.message || "CSV import failed" });
  }
});

router.post("/commerce/send-collections", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    if (!phone) return res.status(400).json({ error: "phone required" });
    const result = await sendCollectionsList(companyIdOf(req), phone);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e?.message || "Send failed" });
  }
});

router.post("/commerce/send-collection", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const collectionId = req.body?.collectionId;
    if (!phone || !collectionId) return res.status(400).json({ error: "phone and collectionId required" });
    const result = await sendCollectionCatalog(companyIdOf(req), phone, collectionId);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e?.message || "Send failed" });
  }
});

router.get("/commerce/orders/meta", async (req, res) => {
  try {
    res.json(await orderPanelMeta(companyIdOf(req)));
  } catch (e) {
    res.status(500).json({ error: commerceUserError(e) });
  }
});

router.get("/commerce/orders/export", async (req, res) => {
  try {
    const orders = await listCommerceOrders(companyIdOf(req), req.query);
    const csv = ordersToCsv(orders);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="nexwapi-orders-${Date.now()}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: commerceUserError(e) });
  }
});

router.get("/commerce/orders", async (req, res) => {
  try {
    const orders = await listCommerceOrders(companyIdOf(req), req.query);
    res.json(orders);
  } catch (e) {
    res.status(500).json({ error: commerceUserError(e) });
  }
});

router.patch("/commerce/orders/:id", async (req, res) => {
  try {
    const cid = companyIdOf(req);
    const existing = await prisma.commerceOrder.findFirst({ where: { id: req.params.id, companyId: cid } });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    const { status, notes, paymentLink, orderStatus, paymentStatus, fulfillmentStatus } = req.body || {};
    const data = {};
    if (status) data.status = String(status);
    if (notes !== undefined) data.notes = String(notes);
    if (paymentLink !== undefined) data.paymentLink = String(paymentLink);
    if (orderStatus) data.orderStatus = String(orderStatus);
    if (paymentStatus) data.paymentStatus = String(paymentStatus);
    if (fulfillmentStatus) data.fulfillmentStatus = String(fulfillmentStatus);

    // Keep legacy status roughly in sync
    if (orderStatus === "cancelled") data.status = "cancelled";
    if (orderStatus === "confirmed" && !status) data.status = paymentStatus === "paid" || existing.paymentStatus === "paid" ? "paid" : "pending_payment";
    if (paymentStatus === "paid" && !status) data.status = "paid";
    if (fulfillmentStatus === "delivered") data.status = "fulfilled";

    const updated = await prisma.commerceOrder.update({ where: { id: existing.id }, data });
    res.json(serializeCommerceOrder(updated));
  } catch (e) {
    res.status(500).json({ error: commerceUserError(e) });
  }
});

/* --------------------------- Integrations marketplace --------------------------- */
router.get("/integrations", async (req, res) => {
  try {
    const apps = await listIntegrationsOverview(companyIdOf(req));
    res.json({ apps });
  } catch (e) {
    console.error("[integrations list]", e?.message || e);
    res.status(500).json({ error: e?.message || "Failed to load integrations" });
  }
});

router.post("/integrations/:provider/connect", async (req, res) => {
  try {
    const provider = String(req.params.provider || "");
    const data = await connectIntegration(companyIdOf(req), provider, req.body?.config || req.body || {});
    res.json({ ok: true, connection: data });
  } catch (e) {
    console.error("[integrations connect]", e?.message || e);
    res.status(e.status || 400).json({ error: e?.message || "Connect failed" });
  }
});

router.post("/integrations/:provider/disconnect", async (req, res) => {
  try {
    const data = await disconnectIntegration(companyIdOf(req), String(req.params.provider || ""));
    res.json({ ok: true, connection: data });
  } catch (e) {
    res.status(400).json({ error: e?.message || "Disconnect failed" });
  }
});

router.get("/integrations/:provider", async (req, res) => {
  try {
    const row = await getOrCreateIntegration(companyIdOf(req), String(req.params.provider || ""));
    res.json(serializeIntegration(row));
  } catch (e) {
    res.status(400).json({ error: e?.message || "Not found" });
  }
});

router.post("/integrations/:provider/rotate-secret", async (req, res) => {
  try {
    const data = await rotateIntegrationSecret(companyIdOf(req), String(req.params.provider || ""));
    res.json({ ok: true, connection: data });
  } catch (e) {
    res.status(400).json({ error: e?.message || "Rotate failed" });
  }
});

router.post("/integrations/:provider/sync-products", async (req, res) => {
  try {
    const provider = String(req.params.provider || "");
    let result;
    if (provider === "woocommerce") result = await syncWooProducts(companyIdOf(req));
    else if (provider === "shopify") result = await syncShopifyProducts(companyIdOf(req));
    else return res.status(400).json({ error: "Product sync not supported for this app" });
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e?.message || "Sync failed" });
  }
});

router.post("/integrations/:provider/test-hook", async (req, res) => {
  try {
    const provider = String(req.params.provider || "");
    const cid = companyIdOf(req);
    let result;
    if (provider === "google_sheets") {
      result = await handleGoogleSheetRow(cid, req.body || {
        name: "Test Lead",
        phone: req.body?.phone || "919999999999",
        email: "test@example.com",
      });
    } else if (provider === "facebook_leads") {
      result = await handleFacebookLead(cid, req.body || {
        name: "FB Test Lead",
        phone: req.body?.phone || "919999999999",
        email: "fbtest@example.com",
      });
    } else if (provider === "woocommerce") {
      result = await handleWooWebhook(cid, "order.created", req.body || {
        id: "test",
        billing: { first_name: "Woo", last_name: "Test", phone: req.body?.phone || "919999999999", email: "woo@test.com" },
        status: "processing",
      });
    } else if (provider === "shopify") {
      result = await handleShopifyWebhook(cid, "orders/create", req.body || {
        id: "test",
        customer: { first_name: "Shop", last_name: "Test", phone: req.body?.phone || "919999999999", email: "shop@test.com" },
      });
    } else {
      return res.status(400).json({ error: "Test not available for this provider" });
    }
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e?.message || "Test failed" });
  }
});

/* ------------------------------ Segments ------------------------------- */

router.get("/segments", async (req, res) => {
  const segments = await prisma.segment.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  const cid = companyIdOf(req);
  const withCounts = await Promise.all(
    segments.map(async (s) => {
      const contactWhere = buildSegmentContactWhere(s, cid);
      const count = await prisma.contact.count({ where: contactWhere });
      return { ...s, createdAt: s.createdAt.getTime(), updatedAt: s.updatedAt?.getTime?.() || s.createdAt.getTime(), count };
    })
  );
  res.json(withCounts);
});

router.get("/segments/:id", async (req, res) => {
  const seg = await prisma.segment.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!seg) return res.sendStatus(404);
  const contactWhere = buildSegmentContactWhere(seg, companyIdOf(req));
  const count = await prisma.contact.count({ where: contactWhere });
  const contacts = await prisma.contact.findMany({ where: contactWhere, orderBy: { createdAt: "desc" }, take: 100 });
  res.json({
    ...seg,
    createdAt: seg.createdAt.getTime(),
    updatedAt: seg.updatedAt?.getTime?.() || seg.createdAt.getTime(),
    count,
    contacts: contacts.map((c) => ({ ...c, createdAt: c.createdAt.getTime() })),
  });
});

router.post("/segments", async (req, res) => {
  const { name, description, tags = [], match = "any", filters, whatsappOnly = true } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const seg = await prisma.segment.create({
    data: { companyId: companyIdOf(req), name, description: description || null, tags, match, filters: filters || null, whatsappOnly },
  });
  const count = await prisma.contact.count({ where: buildSegmentContactWhere(seg, companyIdOf(req)) });
  res.status(201).json({ ...seg, createdAt: seg.createdAt.getTime(), updatedAt: seg.updatedAt.getTime(), count });
});

router.patch("/segments/:id", async (req, res) => {
  const existing = await prisma.segment.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!existing) return res.sendStatus(404);
  const { name, description, tags, match, filters, whatsappOnly } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = name;
  if (description !== undefined) data.description = description;
  if (tags !== undefined) data.tags = tags;
  if (match !== undefined) data.match = match;
  if (filters !== undefined) data.filters = filters;
  if (whatsappOnly !== undefined) data.whatsappOnly = whatsappOnly;
  const seg = await prisma.segment.update({ where: { id: existing.id }, data });
  const count = await prisma.contact.count({ where: buildSegmentContactWhere(seg, companyIdOf(req)) });
  res.json({ ...seg, createdAt: seg.createdAt.getTime(), updatedAt: seg.updatedAt.getTime(), count });
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

router.get("/segments/:id/contacts", async (req, res) => {
  const seg = await prisma.segment.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!seg) return res.sendStatus(404);
  const contactWhere = buildSegmentContactWhere(seg, companyIdOf(req));
  const page = parseInt(req.query.page) || 1;
  const take = parseInt(req.query.limit) || 50;
  const skip = (page - 1) * take;
  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({ where: contactWhere, orderBy: { createdAt: "desc" }, take, skip }),
    prisma.contact.count({ where: contactWhere }),
  ]);
  res.json({ contacts: contacts.map((c) => ({ ...c, createdAt: c.createdAt.getTime() })), total, page, pages: Math.ceil(total / take) });
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
    if (!(await otpGate(req, res, "label_delete"))) return;
    const deleted = await prisma.label.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ----------------------- Audience / contact tags ----------------------- */
router.get("/tags", async (req, res) => {
  if (!(await userHasWorkspacePermission(req, "settings.tags")) && !(await userHasWorkspacePermission(req, "contacts.access"))) {
    // allow if either tags manage or contacts
  }
  const { listTags, tagsMeta } = await import("../lib/tags.js");
  const deleted = String(req.query.deleted || "") === "1" || String(req.query.deleted || "") === "true";
  const [tags, meta] = await Promise.all([
    listTags(companyIdOf(req), { q: req.query.q, deleted }),
    tagsMeta(companyIdOf(req)),
  ]);
  res.json({ tags, meta, viewDeleted: deleted });
});

router.get("/tags/meta", async (req, res) => {
  const { tagsMeta } = await import("../lib/tags.js");
  res.json(await tagsMeta(companyIdOf(req)));
});

router.post("/tags", async (req, res) => {
  if (!(await userHasWorkspacePermission(req, "settings.tags")) && !(await userHasWorkspacePermission(req, "contacts.bulk_tag"))) {
    const rbac = await resolveWorkspaceRole(req);
    if (!["Owner", "Admin", "Super Admin"].includes(rbac.role)) {
      return res.status(403).json({ error: "You do not have permission to manage tags", code: "PERMISSION_DENIED" });
    }
  }
  try {
    const { createTag } = await import("../lib/tags.js");
    const tag = await createTag(companyIdOf(req), {
      name: req.body?.name,
      color: req.body?.color,
      createdBy: req.user?.name || req.user?.email || "",
    });
    res.status(201).json(tag);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
});

router.post("/tags/bulk-delete", async (req, res) => {
  try {
    const { softDeleteTags } = await import("../lib/tags.js");
    const result = await softDeleteTags(companyIdOf(req), req.body?.ids || []);
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

router.post("/tags/:id/restore", async (req, res) => {
  try {
    const { restoreTag } = await import("../lib/tags.js");
    res.json(await restoreTag(companyIdOf(req), req.params.id));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
});

router.delete("/tags/:id", async (req, res) => {
  try {
    const hard = String(req.query.hard || "") === "1";
    if (hard) {
      const { hardDeleteTag } = await import("../lib/tags.js");
      await hardDeleteTag(companyIdOf(req), req.params.id);
      return res.sendStatus(204);
    }
    const { softDeleteTags } = await import("../lib/tags.js");
    await softDeleteTags(companyIdOf(req), [req.params.id]);
    res.sendStatus(204);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
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
  const sendTextBody = outboundTextWithAgent(req, text);
  const creds = await getEffectiveCreds(companyId);
  let waId = null;
  try {
    assertLiveCreds(creds);
    const result = await sendText(contact.phone, sendTextBody, creds);
    waId = result.messages?.[0]?.id || null;
  } catch (e) {
    const status = e.status || (e.code === "WA_CREDS_INCOMPLETE" ? 400 : 502);
    return res.status(status).json({ error: e.message, code: e.code || undefined });
  }

  const msg = await prisma.message.create({
    data: {
      companyId,
      contactId: contact.id,
      waId,
      direction: "out",
      type: "text",
      text: sendTextBody,
      status: "sent",
      senderName: req.user?.name || null,
      senderUserId: req.user?.id || null,
    },
  });
  await clearDelayedReplyFlag(contact.id).catch(() => {});
  res.status(201).json(toMessage(msg));
});

// Send an approved template to a contact (business-initiated — works outside the 24h window).
router.post("/conversations/:id/send-template", requireNotSuspended, async (req, res) => {
  const contact = await tenantContact(req, req.params.id);
  if (!contact) return res.sendStatus(404);
  const { template, params = [], language = "en" } = req.body || {};
  if (!template) return res.status(400).json({ error: "template required" });
  const companyId = companyIdOf(req);
  let charge = { charged: false, creditsNeeded: 0 };
  try {
    charge = await templateChargeCredits(companyId, template, { to: contact.phone });
  } catch (e) {
    return res.status(e.status || 402).json({ error: e.message, code: e.code || "NO_CREDITS" });
  }

  const creds = await getEffectiveCreds(companyId);
  let waId = null;
  try {
    assertLiveCreds(creds);
    const result = params.length
      ? await sendTemplateWithParams(contact.phone, template, params, language, creds)
      : await sendTemplate(contact.phone, template, language, creds);
    waId = result.messages?.[0]?.id || null;
  } catch (e) {
    if (charge.charged) {
      await refundCredits(companyId, charge.creditsNeeded, "message_refund", {
        to: contact.phone,
        reason: e.message,
        template,
      }).catch(() => {});
    }
    const status = e.status || (e.code === "WA_CREDS_INCOMPLETE" ? 400 : 502);
    return res.status(status).json({ error: e.message, code: e.code || undefined });
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
      senderName: req.user?.name || null,
      senderUserId: req.user?.id || null,
    },
  });
  res.status(201).json(toMessage(msg));
});

/* ------------------------------ Templates ------------------------------ */
// Built-in library templates (no Meta needed — demo/default)
const TEMPLATE_LIBRARY = [
  {
    id: "lib_promo_offer",
    name: "exclusive_offer",
    category: "PROMOTIONAL",
    language: "en",
    status: "approved",
    body: "🌟 Hi there! We at {{1}} are excited to offer you an exclusive discount on our latest products!\nUse the code **{{2}}** at checkout to enjoy 20% off your purchase.\nHurry, the offer is valid until the end of the month! 🛍️✨",
    format: "text",
    isLibrary: true,
    createdAt: 0,
  },
  {
    id: "lib_promo_launch",
    name: "new_product_launch",
    category: "PROMOTIONAL",
    language: "en",
    status: "approved",
    body: "🚀 Exciting News! We're thrilled to announce the launch of our latest product: **{{1}}**!\nExperience features like never before! Visit our website to explore more.",
    format: "text",
    isLibrary: true,
    createdAt: 0,
  },
  {
    id: "lib_promo_sale",
    name: "mega_sale_announcement",
    category: "PROMOTIONAL",
    language: "en",
    status: "approved",
    body: "🎉 It's that time of the year again! Our Mega Sale is LIVE!\nGet up to **{{1}}% OFF** on all products. Shop now before stocks run out!\nUse code: **{{2}}** 🛒",
    format: "text",
    isLibrary: true,
    createdAt: 0,
  },
  {
    id: "lib_promo_referral",
    name: "referral_program",
    category: "PROMOTIONAL",
    language: "en",
    status: "approved",
    body: "👋 Hi {{1}}! Refer a friend to {{2}} and both of you get ₹{{3}} off your next order!\nShare your referral link: {{4}}",
    format: "text",
    isLibrary: true,
    createdAt: 0,
  },
  {
    id: "lib_service_notification",
    name: "service_notification",
    category: "SERVICE ALERTS",
    language: "en",
    status: "approved",
    body: "🔔 Service Update: Dear {{1}}, we wanted to let you know about an important update regarding your account.\n{{2}}\nIf you have questions, reply to this message.",
    format: "text",
    isLibrary: true,
    createdAt: 0,
  },
  {
    id: "lib_txn_success",
    name: "transaction_successful",
    category: "TRANSACTIONAL",
    language: "en",
    status: "approved",
    body: "✅ Hi {{1}}, your payment of **₹{{2}}** was successful!\nThank you for choosing {{3}}. Your order will be processed shortly.\nIf you have any questions, feel free to reach out to us!",
    format: "text",
    isLibrary: true,
    createdAt: 0,
  },
  {
    id: "lib_txn_order",
    name: "order_status_update",
    category: "TRANSACTIONAL",
    language: "en",
    status: "approved",
    body: "📦 Hi {{1}}, your order #{{2}} has been shipped!\nYou can expect delivery by **{{3}}**.\nIf you have any questions, just ask!",
    format: "text",
    isLibrary: true,
    createdAt: 0,
  },
  {
    id: "lib_lead_thankyou",
    name: "thank_you_for_reaching_out",
    category: "LEAD QUALIFICATION",
    language: "en",
    status: "approved",
    body: "🙏 Hi {{1}}, thank you for submitting your interest in {{2}}.\nWe appreciate your interest and one of our team members will get back to you shortly to discuss how we can assist you!",
    format: "text",
    isLibrary: true,
    createdAt: 0,
  },
  {
    id: "lib_lead_product_info",
    name: "product_information_request",
    category: "LEAD QUALIFICATION",
    language: "en",
    status: "approved",
    body: "Hi {{1}}, thank you for your interest in {{2}}. Here are some details:\n\n{{3}}\n\nWould you like to schedule a call to learn more?",
    format: "text",
    isLibrary: true,
    createdAt: 0,
  },
];

router.get("/templates/library", async (req, res) => {
  // Production: fetch approved templates from Meta when live
  if (WA_LIVE) {
    try {
      const creds = await getEffectiveCreds(companyIdOf(req));
      if (creds?.wabaId && creds?.accessToken) {
        const metaTemplates = await listTemplates(creds);
        const approved = (metaTemplates || []).filter((t) => String(t.status).toUpperCase() === "APPROVED");
        const mapped = approved.map((mt) => {
          const bodyComp = (mt.components || []).find((c) => c.type === "BODY");
          const body = bodyComp?.text || "(no body)";
          return {
            id: `meta_${mt.name}_${mt.language}`,
            name: mt.name,
            category: cap(mt.category || "Utility"),
            language: mt.language || "en",
            status: "approved",
            body,
            format: "text",
            isLibrary: true,
            fromMeta: true,
            createdAt: 0,
          };
        });
        if (mapped.length > 0) return res.json(mapped);
      }
    } catch (e) {
      console.warn("[templates/library] Meta fetch failed:", e.message);
    }
  }
  // Fallback: starter templates (must be submitted to Meta via "Use template")
  res.json(TEMPLATE_LIBRARY.map((t) => ({ ...t, fromMeta: false, note: "Submit to Meta to use in campaigns" })));
});

router.get("/templates", async (req, res) => {
  const tab = req.query.tab; // "active" (default) | "deleted"
  const whereClause = {
    ...tenantWhere(req),
    deletedAt: tab === "deleted" ? { not: null } : null,
  };
  // status filter
  if (req.query.status) whereClause.status = req.query.status;
  // category filter
  if (req.query.category) whereClause.category = req.query.category;
  const templates = await prisma.template.findMany({ where: whereClause, orderBy: { createdAt: "desc" } });
  res.json(templates.map((t) => ({ ...t, createdAt: t.createdAt.getTime() })));
});

router.post("/templates", async (req, res) => {
  if (!(await userHasWorkspacePermission(req, "templates.create"))) {
    return res.status(403).json({ error: "You do not have permission for this action", code: "PERMISSION_DENIED", permission: "templates.create" });
  }
  const { name, category = "Utility", body, headerType, headerText, headerImageUrl, buttons, format = "text", cards } = req.body || {};
  let language = req.body?.language || "en";
  if (!name || !body) return res.status(400).json({ error: "name and body required" });
  const cleanName = String(name).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

  let status = "pending";
  try {
    const creds = await getEffectiveCreds(companyIdOf(req));
    assertLiveCreds(creds);
    if (!creds?.wabaId) throw Object.assign(new Error("Connect WhatsApp first (Dashboard → WhatsApp), then submit templates."), { status: 400 });
    const r = format === "carousel" && Array.isArray(cards) && cards.length
      ? await createCarouselTemplate({ name: cleanName, category, language, body, cards }, creds)
      : await createTemplate({ name: cleanName, category, language, body, headerType, headerText, headerImageUrl, buttons }, creds);
    status = (r.status || "pending").toLowerCase();
    if (r.language) language = r.language;
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code || undefined });
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
    res.status(201).json({ ...tpl, createdAt: tpl.createdAt.getTime() });
    notify({
      audience: "admin",
      title: "Template submitted",
      body: `${cleanName} from ${req.company?.name || req.user?.email}`,
      href: "/admin/templates",
    }).catch(() => {});
    notify({
      audience: "client",
      companyId: companyIdOf(req),
      title: "Template submitted",
      body: `${cleanName} is pending approval`,
      href: "/dashboard/templates",
    }).catch(() => {});
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Template name already exists" });
    throw e;
  }
});

router.patch("/templates/:id", async (req, res) => {
  const existing = await prisma.template.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!existing) return res.sendStatus(404);
  const data = {};
  if (req.body?.body != null) data.body = String(req.body.body);
  if (req.body?.category != null) data.category = String(req.body.category);
  if (req.body?.language != null) data.language = String(req.body.language);
  if (req.body?.format != null) data.format = String(req.body.format);
  if (req.body?.cards !== undefined) data.cards = req.body.cards;
  if (req.body?.name) data.name = String(req.body.name).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const tpl = await prisma.template.update({ where: { id: existing.id }, data });
  res.json({ ...tpl, createdAt: tpl.createdAt.getTime() });
});

router.delete("/templates/:id", async (req, res) => {
  if (!(await userHasWorkspacePermission(req, "templates.delete"))) {
    return res.status(403).json({ error: "You do not have permission for this action", code: "PERMISSION_DENIED", permission: "templates.delete" });
  }
  if (!(await otpGate(req, res, "template_delete"))) return;
  const existing = await prisma.template.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!existing) return res.sendStatus(404);
  // Soft-delete: move to "deleted" tab
  await prisma.template.update({ where: { id: existing.id }, data: { deletedAt: new Date(), status: "deleted" } });
  res.sendStatus(204);
});

// Pull the latest template statuses from Meta and reconcile the local list.
router.post("/templates/sync", async (req, res) => {
  try {
    const creds = await getEffectiveCreds(companyIdOf(req));
    assertLiveCreds(creds);
    if (!creds?.wabaId) return res.status(400).json({ error: "Connect WhatsApp first, then sync templates." });
    const metaTemplates = await listTemplates(creds);
    for (const mt of metaTemplates) {
      const status = (mt.status || "").toLowerCase();
      const existing = await prisma.template.findFirst({ where: { name: mt.name, ...tenantWhere(req) } });
      if (existing) {
        const prev = existing.status;
        await prisma.template.update({ where: { id: existing.id }, data: { status, category: cap(mt.category), language: mt.language } });
        if (prev !== status && /approv|reject/i.test(status)) {
          notifyOwnerTemplate(companyIdOf(req), mt.name, status);
        }
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
function serializeCampaign(c) {
  return {
    ...c,
    createdAt: c.createdAt instanceof Date ? c.createdAt.getTime() : c.createdAt,
    scheduledAt: c.scheduledAt instanceof Date ? c.scheduledAt.getTime() : (c.scheduledAt || null),
    liveAt: c.liveAt instanceof Date ? c.liveAt.getTime() : (c.liveAt || null),
  };
}

router.get("/campaigns", async (req, res) => {
  const campaigns = await prisma.campaign.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(campaigns.map(serializeCampaign));
});

router.post("/campaigns", requireNotSuspended, async (req, res) => {
  if (!(await userHasWorkspacePermission(req, "campaigns.create"))) {
    return res.status(403).json({ error: "You do not have permission for this action", code: "PERMISSION_DENIED", permission: "campaigns.create" });
  }
  const { name, template, audience = "All contacts", scheduledAt, campaignType = "onetime", category, status: reqStatus } = req.body || {};
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
      campaignType,
      category: category || null,
      status: reqStatus || "scheduled",
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    },
  });
  res.status(201).json(serializeCampaign(campaign));
});

// Update campaign (name, status pause/cancel, scheduledAt)
router.patch("/campaigns/:id", async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!campaign) return res.sendStatus(404);
  const { name, status, scheduledAt } = req.body || {};
  const allowed = ["scheduled", "paused", "cancelled"];
  if (status && !allowed.includes(status)) return res.status(400).json({ error: "Cannot set status to " + status });
  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      ...(name ? { name } : {}),
      ...(status ? { status } : {}),
      ...(scheduledAt !== undefined ? { scheduledAt: scheduledAt ? new Date(scheduledAt) : null } : {}),
    },
  });
  res.json(serializeCampaign(updated));
});

router.delete("/campaigns/:id", async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!campaign) return res.sendStatus(404);
  if (campaign.status === "running") return res.status(409).json({ error: "Cannot delete a running campaign" });
  await prisma.campaign.delete({ where: { id: campaign.id } });
  res.json({ ok: true });
});

// Broadcast engine — send now (the scheduler auto-runs scheduled ones).
router.post("/campaigns/:id/send", requireNotSuspended, async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!campaign) return res.sendStatus(404);
  if (campaign.status === "running") return res.status(409).json({ error: "Campaign already running" });
  try {
    // Mark liveAt
    await prisma.campaign.update({ where: { id: campaign.id }, data: { liveAt: new Date() } });
    const result = await runCampaign(campaign.id);
    res.json({ ok: true, status: "completed", ...result });
  } catch (e) {
    console.error("[campaign] run error:", e.message);
    res.status(400).json({ error: e.message || "Campaign failed" });
  }
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
    if (!(await otpGate(req, res, "drip_delete"))) return;
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
router.get("/automations", asyncRoute(async (req, res) => {
  const items = await prisma.automation.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(items.map((a) => ({ ...a, createdAt: a.createdAt.getTime(), updatedAt: a.updatedAt.getTime() })));
}));

router.post("/automations", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { name, keyword = "", matchType = "contains", reply, enabled = true } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "Rule name is required" });
  if (!reply?.trim()) return res.status(400).json({ error: "Reply message is required" });
  const a = await prisma.automation.create({
    data: {
      companyId,
      name: name.trim(),
      keyword: String(keyword || ""),
      matchType: matchType || "contains",
      reply: reply.trim(),
      enabled: Boolean(enabled),
    },
  });
  res.status(201).json({ ...a, createdAt: a.createdAt.getTime(), updatedAt: a.updatedAt.getTime() });
}));

router.patch("/automations/toggle-all", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { enabled } = req.body || {};
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: { customRepliesEnabled: Boolean(enabled) },
    create: { companyId, businessName: req.company?.name || "Nexwapi", customRepliesEnabled: Boolean(enabled) },
  });
  res.json({ customRepliesEnabled: s.customRepliesEnabled });
}));

router.patch("/automations/:id", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { enabled, name, keyword, matchType, reply } = req.body || {};
  const existing = await prisma.automation.findFirst({ where: { id: req.params.id, companyId } });
  if (!existing) return res.sendStatus(404);
  const a = await prisma.automation.update({
    where: { id: existing.id },
    data: {
      ...(enabled !== undefined && { enabled }),
      ...(name !== undefined && { name: String(name).trim() }),
      ...(keyword !== undefined && { keyword: String(keyword) }),
      ...(matchType !== undefined && { matchType }),
      ...(reply !== undefined && { reply: String(reply).trim() }),
    },
  });
  res.json({ ...a, createdAt: a.createdAt.getTime(), updatedAt: a.updatedAt.getTime() });
}));

router.delete("/automations/:id", async (req, res) => {
  try {
    if (!(await otpGate(req, res, "automation_delete"))) return;
    const deleted = await prisma.automation.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------- Chatbot Flows ------------------------------- */
router.get("/flows/overview", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const [items, setting, wa] = await Promise.all([
    prisma.flow.findMany({ where: { companyId }, orderBy: { updatedAt: "desc" } }),
    prisma.setting.findUnique({ where: { companyId } }),
    prisma.whatsAppAccount.findFirst({ where: { companyId, isDefault: true } }),
  ]);
  const totalSent = items.reduce((s, f) => s + (f.sentCount || 0), 0);
  res.json({
    items: items.map((f) => ({
      ...f,
      actionType: "Workflow",
      createdAt: f.createdAt.getTime(),
      updatedAt: f.updatedAt.getTime(),
    })),
    totalSent,
    whatsappConnected: Boolean(wa?.isConnected),
    intentMatchingEnabled: Boolean(setting?.intentMatchingEnabled),
    flowFollowUpEnabled: Boolean(setting?.flowFollowUpEnabled),
    flowFollowUpMinutes: setting?.flowFollowUpMinutes ?? 30,
    flowFollowUpMessage: setting?.flowFollowUpMessage ?? "",
    flowIdleTimeoutMinutes: setting?.flowIdleTimeoutMinutes ?? 60,
  });
}));

router.get("/flows/settings", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const s = await prisma.setting.findUnique({ where: { companyId } });
  res.json({
    flowFollowUpEnabled: Boolean(s?.flowFollowUpEnabled),
    flowFollowUpMinutes: s?.flowFollowUpMinutes ?? 30,
    flowFollowUpMessage: s?.flowFollowUpMessage ?? "Hi! Just checking in — would you like to continue?",
    flowIdleTimeoutMinutes: s?.flowIdleTimeoutMinutes ?? 60,
  });
}));

router.get("/flows", asyncRoute(async (req, res) => {
  const flows = await prisma.flow.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(flows.map((f) => ({ ...f, createdAt: f.createdAt.getTime(), updatedAt: f.updatedAt.getTime() })));
}));

router.post("/flows", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { name, triggerType = "keyword", trigger = "", steps } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "Flow name is required" });
  const defaultSteps = [
    { id: "start", message: "Hi! 👋 How can we help you today?", buttons: [{ title: "Pricing", next: "pricing" }, { title: "Talk to agent", next: "agent" }] },
    { id: "pricing", message: "See all our plans here: https://nexwapi.com/pricing", buttons: [] },
    { id: "agent", message: "Sure! One of our agents will reach out to you shortly. 🙌", buttons: [] },
  ];
  const flow = await prisma.flow.create({
    data: {
      companyId,
      name: name.trim(),
      triggerType,
      trigger,
      steps: Array.isArray(steps) && steps.length ? steps : defaultSteps,
    },
  });
  res.status(201).json({ ...flow, createdAt: flow.createdAt.getTime(), updatedAt: flow.updatedAt.getTime() });
}));

router.patch("/flows/settings", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { flowFollowUpEnabled, flowFollowUpMinutes, flowFollowUpMessage, flowIdleTimeoutMinutes } = req.body || {};
  const data = {
    ...(flowFollowUpEnabled !== undefined && { flowFollowUpEnabled: Boolean(flowFollowUpEnabled) }),
    ...(flowFollowUpMinutes !== undefined && { flowFollowUpMinutes: Math.max(5, Number(flowFollowUpMinutes) || 30) }),
    ...(flowFollowUpMessage !== undefined && { flowFollowUpMessage: String(flowFollowUpMessage) }),
    ...(flowIdleTimeoutMinutes !== undefined && {
      flowIdleTimeoutMinutes: Number(flowIdleTimeoutMinutes) <= 0
        ? 0
        : Math.max(5, Number(flowIdleTimeoutMinutes) || 60),
    }),
  };
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: data,
    create: { companyId, businessName: req.company?.name || "Nexwapi", ...data },
  });
  res.json({
    flowFollowUpEnabled: Boolean(s.flowFollowUpEnabled),
    flowFollowUpMinutes: s.flowFollowUpMinutes,
    flowFollowUpMessage: s.flowFollowUpMessage,
    flowIdleTimeoutMinutes: s.flowIdleTimeoutMinutes,
  });
}));

/* ---------------------- Advanced automation features ------------------- */
router.patch("/automation/intent-matching", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { enabled } = req.body || {};
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: { intentMatchingEnabled: Boolean(enabled) },
    create: { companyId, businessName: req.company?.name || "Nexwapi", intentMatchingEnabled: Boolean(enabled) },
  });
  res.json({ intentMatchingEnabled: s.intentMatchingEnabled });
}));

router.patch("/flows/:id", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { name, triggerType, trigger, enabled, steps } = req.body || {};
  const existing = await prisma.flow.findFirst({ where: { id: req.params.id, companyId } });
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
  res.json({ ...flow, createdAt: flow.createdAt.getTime(), updatedAt: flow.updatedAt.getTime() });
}));

router.get("/automation/ai-agent", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const s = await prisma.setting.findUnique({ where: { companyId } });
  res.json({
    enabled: s?.aiAgentEnabled ?? false,
    websiteUrl: s?.aiAgentWebsiteUrl ?? "",
    greeting: s?.aiAgentGreeting ?? "",
    knowledge: Array.isArray(s?.aiAgentKnowledge) ? s.aiAgentKnowledge : [],
  });
}));

router.patch("/automation/ai-agent", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { enabled, websiteUrl, greeting, knowledge } = req.body || {};
  const data = {
    ...(enabled !== undefined && { aiAgentEnabled: Boolean(enabled) }),
    ...(websiteUrl !== undefined && { aiAgentWebsiteUrl: String(websiteUrl) }),
    ...(greeting !== undefined && { aiAgentGreeting: String(greeting) }),
    ...(knowledge !== undefined && { aiAgentKnowledge: knowledge }),
  };
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: data,
    create: { companyId, businessName: req.company?.name || "Nexwapi", ...data },
  });
  res.json({
    enabled: s.aiAgentEnabled,
    websiteUrl: s.aiAgentWebsiteUrl,
    greeting: s.aiAgentGreeting,
    knowledge: Array.isArray(s.aiAgentKnowledge) ? s.aiAgentKnowledge : [],
  });
}));

router.post("/automation/ai-agent/sync-website", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { url } = req.body || {};
  const { syncWebsiteKnowledge } = await import("../lib/aiAgent.js");
  const result = await syncWebsiteKnowledge(companyId, url);
  res.json({ ok: true, ...result });
}));

router.post("/automation/ai-agent/documents", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { title, content } = req.body || {};
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: "title and content required" });
  const s = await prisma.setting.findUnique({ where: { companyId } });
  const existing = Array.isArray(s?.aiAgentKnowledge) ? s.aiAgentKnowledge : [];
  const knowledge = [...existing, { title: title.trim(), source: "document", content: content.trim() }];
  const updated = await prisma.setting.upsert({
    where: { companyId },
    update: { aiAgentKnowledge: knowledge },
    create: { companyId, businessName: req.company?.name || "Nexwapi", aiAgentKnowledge: knowledge },
  });
  res.status(201).json({ knowledge: updated.aiAgentKnowledge });
}));

router.get("/automation/voice-ai", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const s = await prisma.setting.findUnique({ where: { companyId } });
  res.json({
    enabled: s?.voiceAiEnabled ?? false,
    plan: s?.voiceAiPlan ?? "business",
    credits: s?.voiceAiCredits ?? 100,
  });
}));

router.patch("/automation/voice-ai", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { enabled, plan, credits } = req.body || {};
  const data = {
    ...(enabled !== undefined && { voiceAiEnabled: Boolean(enabled) }),
    ...(plan !== undefined && { voiceAiPlan: String(plan) }),
    ...(credits !== undefined && { voiceAiCredits: Math.max(0, Number(credits) || 0) }),
  };
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: data,
    create: { companyId, businessName: req.company?.name || "Nexwapi", ...data },
  });
  res.json({ enabled: s.voiceAiEnabled, plan: s.voiceAiPlan, credits: s.voiceAiCredits });
}));

router.get("/whatsapp-forms", asyncRoute(async (req, res) => {
  const items = await prisma.whatsAppForm.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(items.map((f) => ({ ...f, createdAt: f.createdAt.getTime(), updatedAt: f.updatedAt.getTime() })));
}));

router.post("/whatsapp-forms", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { name, triggerKeyword, fields, thankYouMessage, enabled = true } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "Form name is required" });
  const f = await prisma.whatsAppForm.create({
    data: {
      companyId,
      name: name.trim(),
      triggerKeyword: triggerKeyword || "",
      fields: Array.isArray(fields) ? fields : [],
      thankYouMessage: thankYouMessage || "Thanks! We received your details.",
      enabled: Boolean(enabled),
    },
  });
  res.status(201).json({ ...f, createdAt: f.createdAt.getTime(), updatedAt: f.updatedAt.getTime() });
}));

router.patch("/whatsapp-forms/:id", async (req, res) => {
  const existing = await prisma.whatsAppForm.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!existing) return res.sendStatus(404);
  const { name, triggerKeyword, fields, thankYouMessage, enabled } = req.body || {};
  const f = await prisma.whatsAppForm.update({
    where: { id: existing.id },
    data: {
      ...(name !== undefined && { name }),
      ...(triggerKeyword !== undefined && { triggerKeyword }),
      ...(fields !== undefined && { fields }),
      ...(thankYouMessage !== undefined && { thankYouMessage }),
      ...(enabled !== undefined && { enabled }),
    },
  });
  res.json({ ...f, createdAt: f.createdAt.getTime(), updatedAt: f.updatedAt.getTime() });
});

router.delete("/whatsapp-forms/:id", async (req, res) => {
  const deleted = await prisma.whatsAppForm.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!deleted.count) return res.sendStatus(404);
  res.sendStatus(204);
});

router.get("/interactive-lists", async (req, res) => {
  const items = await prisma.interactiveList.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(items.map((l) => ({ ...l, createdAt: l.createdAt.getTime(), updatedAt: l.updatedAt.getTime() })));
});

router.post("/interactive-lists", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  const { name, header, body, footer, buttonText, sections, enabled = true } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "List name is required" });
  const l = await prisma.interactiveList.create({
    data: {
      companyId,
      name: name.trim(),
      header: header || "",
      body: body || "",
      footer: footer || "",
      buttonText: buttonText || "View options",
      sections: Array.isArray(sections) ? sections : [],
      enabled: Boolean(enabled),
    },
  });
  res.status(201).json({ ...l, createdAt: l.createdAt.getTime(), updatedAt: l.updatedAt.getTime() });
}));

router.patch("/interactive-lists/:id", async (req, res) => {
  const existing = await prisma.interactiveList.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!existing) return res.sendStatus(404);
  const { name, header, body, footer, buttonText, sections, enabled } = req.body || {};
  const l = await prisma.interactiveList.update({
    where: { id: existing.id },
    data: {
      ...(name !== undefined && { name }),
      ...(header !== undefined && { header }),
      ...(body !== undefined && { body }),
      ...(footer !== undefined && { footer }),
      ...(buttonText !== undefined && { buttonText }),
      ...(sections !== undefined && { sections }),
      ...(enabled !== undefined && { enabled }),
    },
  });
  res.json({ ...l, createdAt: l.createdAt.getTime(), updatedAt: l.updatedAt.getTime() });
});

router.delete("/interactive-lists/:id", async (req, res) => {
  const deleted = await prisma.interactiveList.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
  if (!deleted.count) return res.sendStatus(404);
  res.sendStatus(204);
});

router.delete("/flows/:id", asyncRoute(async (req, res) => {
  const companyId = requireWorkspace(req, res);
  if (!companyId) return;
  if (!(await otpGate(req, res, "flow_delete"))) return;
  const existing = await prisma.flow.findFirst({ where: { id: req.params.id, companyId } });
  if (!existing) return res.sendStatus(404);
  await prisma.contact.updateMany({ where: { activeFlowId: existing.id, companyId }, data: { activeFlowId: null, activeFlowStep: null } });
  await prisma.flow.delete({ where: { id: existing.id } });
  res.sendStatus(204);
}));

/* ------------------------------ Events Settings ------------------------------- */
router.get("/events-settings", async (req, res) => {
  const { listEventsSettings } = await import("../lib/customEvents.js");
  res.json(await listEventsSettings(companyIdOf(req)));
});

router.post("/events-settings/custom", async (req, res) => {
  try {
    const { createCustomEvent } = await import("../lib/customEvents.js");
    const row = await createCustomEvent(companyIdOf(req), {
      name: req.body?.name,
      traits: req.body?.traits,
      description: req.body?.description,
      createdBy: req.user?.name || req.user?.email || "",
    });
    res.status(201).json(row);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
});

router.delete("/events-settings/custom/:id", async (req, res) => {
  try {
    const { deleteCustomEvent } = await import("../lib/customEvents.js");
    await deleteCustomEvent(companyIdOf(req), req.params.id);
    res.sendStatus(204);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.sendStatus(404);
  }
});

/* ------------------------------ Settings ------------------------------- */
router.get("/account-details", async (req, res) => {
  const companyId = companyIdOf(req);
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { subscription: true },
  });
  if (!company) return res.status(404).json({ error: "Company not found" });
  const waAccounts = await prisma.whatsAppAccount.findMany({
    where: { companyId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  const wa = waAccounts.find((a) => a.isDefault) || waAccounts[0] || null;
  const plan = normalizePlan(company.plan || "trial");
  const planMeta = planFeatures(plan);
  const sub = company.subscription;
  const trialEndsAt = company.trialEndsAt || sub?.trialEndsAt || null;
  const startAt = sub?.activatedAt || company.upgradedAt || company.trialStartedAt || company.createdAt;
  const endAt = sub?.expiresAt || (plan === "trial" ? trialEndsAt : null);
  const isTrial = plan === "trial" || company.status === "TRIAL";
  const subscriptionType = isTrial
    ? `${planMeta.name || "Growth"} (free trial)`
    : `${planMeta.name || plan}${sub?.billingCycle ? ` · ${sub.billingCycle}` : ""}`;

  const accounts = [
    {
      id: company.id,
      name: company.name,
      initial: String(company.name || "N").slice(0, 1).toUpperCase(),
      type: "whatsapp",
    },
  ];

  res.json({
    accounts,
    activeAccountId: company.id,
    organization: {
      name: company.name,
      creationDate: company.createdAt.getTime(),
      organizationId: company.id,
      facebookBusinessManagerId: wa?.businessId || null,
      whatsappBusinessId: wa?.wabaId || null,
      phoneNumberId: wa?.phoneNumberId || null,
      displayPhoneNumber: wa?.displayPhoneNumber || wa?.phoneNumber || null,
      subscriptionType,
      subscriptionStartDate: startAt ? new Date(startAt).getTime() : null,
      subscriptionEndDate: endAt ? new Date(endAt).getTime() : null,
      plan,
      planName: planMeta.name || plan,
      status: company.status,
      freeAccess: Boolean(company.freeAccess),
    },
    whatsappAccounts: waAccounts.map((a) => ({
      id: a.id,
      name: a.businessName || a.verifiedName || a.displayPhoneNumber || "WhatsApp",
      phone: a.displayPhoneNumber || a.phoneNumber || null,
      wabaId: a.wabaId || null,
      businessId: a.businessId || null,
      isConnected: Boolean(a.isConnected),
      isDefault: Boolean(a.isDefault),
    })),
  });
});

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
    workingHoursSummary: formatWorkingHoursSummary(s),
    workingHoursSlots: Array.isArray(s.workingHoursSlots) && s.workingHoursSlots.length
      ? s.workingHoursSlots
      : defaultWorkingHoursSlots(),
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
  if (wa.isConnected && wa.accessToken && wa.phoneNumberId) {
    ensureStarterMessaging(companyId).catch((e) => console.warn("[starter]", e.message));
  }
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
  const gate = await requireOtpOrSkip(req.user.email, "wa_disconnect", req.body?.otp);
  if (gate.otpRequired) return res.json({ otpRequired: true });
  if (!gate.ok) return res.status(400).json({ error: gate.error || "Invalid OTP" });
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
      try {
        await registerCloudApiPhone(
          wa.phoneNumberId,
          token,
          process.env.WHATSAPP_REGISTER_PIN || "123456"
        );
      } catch (e) {
        console.warn("[wa] phone register on refresh:", e.message);
      }
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

async function loadWaForCompany(req) {
  const companyId = companyIdOf(req);
  if (!companyId) return null;
  return prisma.whatsAppAccount.findFirst({
    where: {
      companyId,
      phoneNumberId: { not: null },
      accessToken: { not: null },
    },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
  });
}

router.get("/whatsapp/profile", async (req, res) => {
  try {
    const companyId = companyIdOf(req);
    const wa = await loadWaForCompany(req);
    const setting = companyId ? await prisma.setting.findUnique({ where: { companyId } }).catch(() => null) : null;
    const local = getLocalWaProfile(companyId);
    const base = {
      displayName: local.displayName || wa?.businessName || setting?.businessName || req.company?.name || "",
      verifiedName: wa?.verifiedName || "",
      phoneNumber: wa?.displayPhoneNumber || wa?.phoneNumber || "",
      about: local.about || "",
      address: local.address || "",
      description: local.description || "",
      email: local.email || "",
      website: local.website || "",
      vertical: local.vertical || "OTHER",
      profilePictureUrl: local.profilePictureUrl || "",
      verticals: VERTICALS,
      live: false,
    };
    if (!wa?.phoneNumberId || !wa?.accessToken) {
      return res.json({ ...base, connected: false, hint: "Connect WhatsApp to sync this profile to Meta. You can still save it here." });
    }
    try {
      const profile = await fetchBusinessProfile(wa.phoneNumberId, wa.accessToken);
      return res.json({
        ...base,
        ...profile,
        displayName: wa.businessName || profile.about || base.displayName,
        website: profile.website || base.website,
        live: true,
        connected: true,
      });
    } catch (e) {
      return res.json({ ...base, connected: true, live: false, hint: e.message });
    }
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.patch("/whatsapp/profile", async (req, res) => {
  try {
    const companyId = companyIdOf(req);
    const { displayName, about, address, description, email, website, vertical } = req.body || {};
    const saved = saveLocalWaProfile(companyId, { displayName, about, address, description, email, website, vertical });
    const wa = await loadWaForCompany(req);
    if (displayName && wa) {
      await prisma.whatsAppAccount.update({ where: { id: wa.id }, data: { businessName: String(displayName).trim() } });
    }
    if (displayName && companyId) {
      await prisma.setting.updateMany({ where: { companyId }, data: { businessName: String(displayName).trim() } });
    }
    if (wa?.phoneNumberId && wa?.accessToken) {
      await updateBusinessProfile(wa.phoneNumberId, wa.accessToken, {
        about, address, description, email, website, vertical,
      });
      const profile = await fetchBusinessProfile(wa.phoneNumberId, wa.accessToken).catch(() => saved);
      return res.json({ ok: true, live: true, profile: { ...profile, displayName: displayName || wa.businessName } });
    }
    res.json({ ok: true, live: false, profile: saved, hint: "Saved in Nexwapi. Connect WhatsApp to push this to Meta." });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/whatsapp/profile/photo", profileUpload.single("file"), async (req, res) => {
  try {
    const wa = await loadWaForCompany(req);
    if (!wa?.phoneNumberId || !wa?.accessToken) {
      return res.status(400).json({ error: "Connect WhatsApp first to upload a logo to Meta." });
    }
    if (!req.file?.buffer) return res.status(400).json({ error: "Image file required (JPG or PNG, max 5MB)" });
    const handle = await uploadProfilePicture(
      wa.accessToken,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );
    await updateBusinessProfile(wa.phoneNumberId, wa.accessToken, { profile_picture_handle: handle });
    const profile = await fetchBusinessProfile(wa.phoneNumberId, wa.accessToken).catch(() => ({}));
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
  const { code, wabaId, phoneNumberId, businessId } = req.body || {};
  if (!code) return res.status(400).json({ error: "OAuth code required from Facebook Login" });

  try {
    // JS SDK Embedded Signup codes must be exchanged WITHOUT redirect_uri.
    const tokenData = await exchangeEmbeddedSignupCode(code);
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

    try {
      await registerCloudApiPhone(
        finalPhoneId,
        accessToken,
        process.env.WHATSAPP_REGISTER_PIN || "123456"
      );
    } catch (e) {
      console.warn("[wa] phone register:", e.message);
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

    ensureStarterMessaging(companyId).catch((e) => console.warn("[starter]", e.message));

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
  const {
    awayEnabled, awayMessage, hoursStart, hoursEnd, days, businessName, autoAssign,
    assignmentMode, assignOnlineOnly, webhookUrl, csatEnabled, csatMessage,
    welcomeEnabled, welcomeMessage, delayedEnabled, delayedMinutes, delayedMessage,
    customRepliesEnabled, workingHoursSlots, rejectOptedOutApi,
  } = req.body || {};
  const data = {
    ...(awayEnabled !== undefined && { awayEnabled }),
    ...(awayMessage !== undefined && { awayMessage }),
    ...(hoursStart !== undefined && { hoursStart: Number(hoursStart) }),
    ...(hoursEnd !== undefined && { hoursEnd: Number(hoursEnd) }),
    ...(days !== undefined && { days }),
    ...(businessName !== undefined && { businessName }),
    ...(autoAssign !== undefined && { autoAssign }),
    ...(assignmentMode !== undefined && { assignmentMode: String(assignmentMode) }),
    ...(assignOnlineOnly !== undefined && { assignOnlineOnly: Boolean(assignOnlineOnly) }),
    ...(webhookUrl !== undefined && { webhookUrl: String(webhookUrl || "").trim() }),
    ...(rejectOptedOutApi !== undefined && { rejectOptedOutApi: Boolean(rejectOptedOutApi) }),
    ...(csatEnabled !== undefined && { csatEnabled }),
    ...(csatMessage !== undefined && { csatMessage }),
    ...(welcomeEnabled !== undefined && { welcomeEnabled }),
    ...(welcomeMessage !== undefined && { welcomeMessage }),
    ...(delayedEnabled !== undefined && { delayedEnabled }),
    ...(delayedMinutes !== undefined && { delayedMinutes: Math.max(1, Number(delayedMinutes) || 15) }),
    ...(delayedMessage !== undefined && { delayedMessage }),
    ...(customRepliesEnabled !== undefined && { customRepliesEnabled: Boolean(customRepliesEnabled) }),
    ...(workingHoursSlots !== undefined && { workingHoursSlots }),
  };
  if (Array.isArray(workingHoursSlots) && workingHoursSlots.length) {
    const daySet = [...new Set(workingHoursSlots.map((s) => s.day).filter(Boolean))];
    if (daySet.length) data.days = daySet;
  }
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: data,
    create: { companyId, businessName: req.company?.name || "Nexwapi", ...data },
  });
  res.json({
    ...s,
    workingHoursSummary: formatWorkingHoursSummary(s),
    workingHoursSlots: Array.isArray(s.workingHoursSlots) && s.workingHoursSlots.length
      ? s.workingHoursSlots
      : defaultWorkingHoursSlots(),
  });
});

/* ------------------------- Developer API keys -------------------------- */
router.get("/api-keys", async (req, res) => {
  const keys = await prisma.apiKey.findMany({ where: tenantWhere(req), orderBy: { createdAt: "desc" } });
  res.json(keys.map(publicApiKeyRow));
});

router.post("/api-keys", requireFeature("api"), async (req, res) => {
  if (!(await userHasWorkspacePermission(req, "settings.api_key"))) {
    return res.status(403).json({ error: "You do not have permission for this action", code: "PERMISSION_DENIED", permission: "settings.api_key" });
  }
  const gate = await requireOtpOrSkip(req.user.email, "api_create", req.body?.otp);
  if (gate.otpRequired) return res.json({ otpRequired: true });
  if (!gate.ok) return res.status(400).json({ error: gate.error || "Invalid OTP" });
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
    const gate = await requireOtpOrSkip(req.user.email, "api_delete", req.body?.otp || req.query?.otp);
    if (gate.otpRequired) return res.json({ otpRequired: true });
    if (!gate.ok) return res.status(400).json({ error: gate.error || "Invalid OTP" });
    const deleted = await prisma.apiKey.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (deleted.count === 0) return res.sendStatus(404);
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

/* ------------------------- Developer settings -------------------------- */
router.get("/developer-settings", async (req, res) => {
  const companyId = companyIdOf(req);
  const [s, keys, wa] = await Promise.all([
    prisma.setting.upsert({
      where: { companyId },
      update: {},
      create: { companyId, businessName: req.company?.name || "Nexwapi" },
    }),
    prisma.apiKey.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } }),
    prisma.whatsAppAccount.findFirst({ where: { companyId, isDefault: true } }),
  ]);
  const primary = keys[0] || null;
  res.json({
    rejectOptedOutApi: s.rejectOptedOutApi !== false,
    webhookUrl: s.webhookUrl || "",
    whatsappConnected: Boolean(wa?.isConnected),
    keys: keys.map(publicApiKeyRow),
    primaryKey: primary
      ? {
          id: primary.id,
          name: primary.name,
          masked: publicApiKeyRow(primary).key,
          createdAt: primary.createdAt.getTime(),
          lastUsedAt: primary.lastUsedAt?.getTime() || null,
        }
      : null,
    docs: {
      api: "https://nexwapi.com/docs/api",
      postman: "https://nexwapi.com/docs/postman",
      nodeSdk: "https://nexwapi.com/docs/node-sdk",
    },
    sendEndpoint: "/api/v1/messages",
  });
});

router.post("/developer-settings/test-webhook", async (req, res) => {
  try {
    const companyId = companyIdOf(req);
    const s = await prisma.setting.findUnique({ where: { companyId } });
    if (!String(s?.webhookUrl || "").trim()) {
      return res.status(400).json({ error: "Configure a webhook URL first" });
    }
    const { fireTestWebhook } = await import("../lib/events.js");
    await fireTestWebhook(companyId);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e?.message || "Test webhook failed" });
  }
});

/* -------------------------- Reports (deep) ----------------------------- */
router.get("/reports", async (req, res) => {
  const tw = tenantWhere(req);
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;
  const end = to ? new Date(to) : null;
  if (end) end.setHours(23, 59, 59, 999);
  const atRange = (from || end) ? { at: { ...(from ? { gte: from } : {}), ...(end ? { lte: end } : {}) } } : {};
  const createdRange = (from || end) ? { createdAt: { ...(from ? { gte: from } : {}), ...(end ? { lte: end } : {}) } } : {};

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
    prisma.message.count({ where: { direction: "in", ...tw, ...atRange } }),
    prisma.message.count({ where: { direction: "out", ...tw, ...atRange } }),
  ]);

  const contacts = await prisma.contact.findMany({ where: tw, select: { tags: true } });
  const tagMap = {};
  contacts.forEach((c) => (c.tags || []).forEach((t) => (tagMap[t] = (tagMap[t] || 0) + 1)));
  const topTags = Object.entries(tagMap).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 8);

  const campaigns = await prisma.campaign.findMany({ where: { ...tw, ...createdRange }, orderBy: { createdAt: "desc" }, take: 20 });

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
    range: {
      from: from ? from.toISOString().slice(0, 10) : null,
      to: to ? to.toISOString().slice(0, 10) : null,
    },
  });
});

function parseReportDateRange(preset, fromStr, toStr) {
  const now = new Date();
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  if (preset === "today") return { from: startOfDay(now), to: endOfDay(now) };
  if (preset === "yesterday") {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return { from: startOfDay(y), to: endOfDay(y) };
  }
  if (preset === "last7") {
    const f = new Date(now); f.setDate(f.getDate() - 6);
    return { from: startOfDay(f), to: endOfDay(now) };
  }
  if (preset === "last30") {
    const f = new Date(now); f.setDate(f.getDate() - 29);
    return { from: startOfDay(f), to: endOfDay(now) };
  }
  const from = fromStr ? startOfDay(new Date(fromStr)) : null;
  const to = toStr ? endOfDay(new Date(toStr)) : null;
  return { from, to };
}

function csvEscape(v) {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

function buildCampaignSummaryCsv(campaigns) {
  const header = ["Campaign Name", "Template", "Audience", "Type", "Status", "Recipients", "Sent", "Delivered", "Read", "Replied", "Failed", "Delivery Rate %", "Read Rate %", "Created At", "Live At"];
  const rows = campaigns.map((c) => {
    const sent = c.sent || 0;
    const delRate = sent ? Math.round(((c.delivered || 0) / sent) * 100) : 0;
    const readRate = sent ? Math.round(((c.read || 0) / sent) * 100) : 0;
    return [
      c.name, c.template, c.audience, c.campaignType, c.status,
      c.recipients, c.sent, c.delivered, c.read, c.replied, c.failed,
      delRate, readRate,
      c.createdAt ? new Date(c.createdAt).toISOString() : "",
      c.liveAt ? new Date(c.liveAt).toISOString() : "",
    ].map(csvEscape).join(",");
  });
  return [header.map(csvEscape).join(","), ...rows].join("\n");
}

async function buildCampaignDetailedCsv(campaigns, companyId, from, to) {
  const summary = buildCampaignSummaryCsv(campaigns);
  const atRange = {};
  if (from) atRange.gte = from;
  if (to) atRange.lte = to;
  const messages = await prisma.message.findMany({
    where: {
      companyId,
      type: "template",
      direction: "out",
      ...(Object.keys(atRange).length ? { at: atRange } : {}),
    },
    include: { contact: { select: { name: true, phone: true } } },
    orderBy: { at: "desc" },
    take: 5000,
  });
  const msgHeader = ["Contact Name", "Phone", "Message Status", "Sent At", "Message Preview"];
  const msgRows = messages.map((m) =>
    [m.contact?.name || "", m.contact?.phone || "", m.status, m.at.toISOString(), (m.text || "").slice(0, 120)]
      .map(csvEscape).join(",")
  );
  return `${summary}\n\n--- Message Details ---\n${msgHeader.map(csvEscape).join(",")}\n${msgRows.join("\n")}`;
}

router.get("/reports/campaigns", async (req, res) => {
  const campaigns = await prisma.campaign.findMany({
    where: tenantWhere(req),
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, campaignType: true, category: true, status: true, createdAt: true },
  });
  res.json(campaigns.map((c) => ({ ...c, createdAt: c.createdAt.getTime() })));
});

router.post("/reports/campaign/email", async (req, res) => {
  const { reportType = "summary", preset, from: fromStr, to: toStr, campaignType, campaignId } = req.body || {};
  const validTypes = ["summary", "detailed", "ctwa"];
  if (!validTypes.includes(reportType)) {
    return res.status(400).json({ error: "reportType must be summary, detailed, or ctwa" });
  }
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true, name: true } });
  if (!user?.email) return res.status(400).json({ error: "No email on account" });

  const { from, to } = parseReportDateRange(preset, fromStr, toStr);
  const where = { ...tenantWhere(req) };
  if (from || to) {
    where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  if (campaignType && campaignType !== "all") where.campaignType = campaignType;
  if (campaignId && campaignId !== "all") where.id = campaignId;
  if (reportType === "ctwa") where.category = { contains: "CTWA", mode: "insensitive" };

  const campaigns = await prisma.campaign.findMany({ where, orderBy: { createdAt: "desc" } });
  const companyId = companyIdOf(req);

  let csv;
  if (reportType === "detailed") {
    csv = await buildCampaignDetailedCsv(campaigns, companyId, from, to);
  } else {
    csv = buildCampaignSummaryCsv(campaigns);
    if (reportType === "ctwa" && campaigns.length === 0) {
      csv = "Note: No CTWA campaigns found in this date range. Connect Meta Click-to-WhatsApp Ads to track ad-driven campaigns.\n" + csv;
    }
  }

  const fromLabel = from ? from.toISOString().slice(0, 10) : "";
  const toLabel = to ? to.toISOString().slice(0, 10) : "";

  try {
    const result = await sendCampaignReportEmail({
      to: user.email,
      reportType,
      from: fromLabel,
      toDate: toLabel,
      csvContent: csv,
      campaignCount: campaigns.length,
    });
    if (result.skipped) {
      return res.status(503).json({
        error: "Email not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in backend .env",
        dryRun: true,
        campaignCount: campaigns.length,
      });
    }
    res.json({ ok: true, email: user.email, campaignCount: campaigns.length });
  } catch (e) {
    res.status(502).json({ error: e.message || "Failed to send report email" });
  }
});

/* ------------------------------ Analytics ------------------------------ */

async function eventContactIds(companyId, event, from, to, tag) {
  if (!event || event === "all") return null;
  const contactFilter = { companyId };
  if (tag && tag !== "all") contactFilter.tags = { has: tag };
  const createdAt = {};
  if (from) createdAt.gte = from;
  if (to) createdAt.lte = to;
  const at = { ...createdAt };

  if (event === "phone_updated" || event === "flow_completed") {
    const rows = await prisma.event.findMany({
      where: {
        type: event,
        ...(Object.keys(createdAt).length ? { createdAt } : {}),
        contact: contactFilter,
      },
      select: { contactId: true },
    });
    const ids = [...new Set(rows.map((r) => r.contactId))];
    return ids.length ? ids : ["__none__"];
  }
  if (event === "notification_sent") {
    const rows = await prisma.message.findMany({
      where: {
        companyId,
        direction: "out",
        type: "template",
        ...(Object.keys(at).length ? { at } : {}),
        ...(tag && tag !== "all" ? { contact: { tags: { has: tag } } } : {}),
      },
      select: { contactId: true },
    });
    const ids = [...new Set(rows.map((r) => r.contactId))];
    return ids.length ? ids : ["__none__"];
  }
  if (event === "ctwa") {
    const rows = await prisma.contact.findMany({
      where: {
        ...contactFilter,
        OR: [
          { tags: { hasSome: ["CTWA", "ctwa", "Click to WhatsApp"] } },
          { attributes: { path: ["source"], equals: "ctwa" } },
        ],
      },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    return ids.length ? ids : ["__none__"];
  }
  if (event === "replied_notification") {
    const outMsgs = await prisma.message.findMany({
      where: {
        companyId,
        direction: "out",
        type: "template",
        ...(Object.keys(at).length ? { at } : {}),
        ...(tag && tag !== "all" ? { contact: { tags: { has: tag } } } : {}),
      },
      select: { contactId: true, at: true },
    });
    const replied = new Set();
    for (const out of outMsgs) {
      const reply = await prisma.message.findFirst({
        where: {
          contactId: out.contactId,
          direction: "in",
          at: { gt: out.at },
          ...(to ? { at: { lte: to } } : {}),
        },
      });
      if (reply) replied.add(out.contactId);
    }
    const ids = [...replied];
    return ids.length ? ids : ["__none__"];
  }
  return null;
}

async function computeChatAnalytics(companyId, { from, to, event, tag }) {
  const contactWhere = { companyId };
  if (tag && tag !== "all") contactWhere.tags = { has: tag };

  let contactIds = tag && tag !== "all"
    ? (await prisma.contact.findMany({ where: contactWhere, select: { id: true } })).map((c) => c.id)
    : null;

  const eventIds = await eventContactIds(companyId, event, from, to, tag);
  if (eventIds) {
    contactIds = contactIds
      ? contactIds.filter((id) => eventIds.includes(id))
      : eventIds;
  }

  const msgWhere = { companyId };
  if (from || to) msgWhere.at = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  if (contactIds) msgWhere.contactId = { in: contactIds.length ? contactIds : ["__none__"] };
  if (event === "inbound") msgWhere.direction = "in";
  else if (event === "outbound") msgWhere.direction = "out";
  else if (event === "auto_reply") {
    msgWhere.direction = "out";
    msgWhere.senderUserId = null;
  }

  const [messages, contacts, automations] = await Promise.all([
    prisma.message.findMany({
      where: msgWhere,
      orderBy: { at: "asc" },
      include: { contact: { select: { id: true, name: true, chatStatus: true, tags: true, assignedAgentId: true, createdAt: true, assignedAgent: { select: { name: true } } } } },
    }),
    prisma.contact.findMany({ where: contactWhere, select: { id: true, chatStatus: true, createdAt: true, tags: true } }),
    prisma.automation.count({ where: { companyId, enabled: true } }),
  ]);

  const openChats = contacts.filter((c) => c.chatStatus === "open").length;
  const pendingChats = contacts.filter((c) => c.chatStatus === "pending").length;
  const resolvedTotal = contacts.filter((c) => c.chatStatus === "resolved").length;

  const inRange = (d) => {
    const t = new Date(d).getTime();
    if (from && t < from.getTime()) return false;
    if (to && t > to.getTime()) return false;
    return true;
  };

  const newConversations = contacts.filter((c) => inRange(c.createdAt)).length;
  const inboundMessages = messages.filter((m) => m.direction === "in").length;
  const outboundMessages = messages.filter((m) => m.direction === "out").length;

  // Group messages by contact
  const byContact = {};
  for (const m of messages) {
    if (!byContact[m.contactId]) byContact[m.contactId] = [];
    byContact[m.contactId].push(m);
  }

  let delayedMessages = 0;
  let autoReplies = 0;
  let totalResponseMin = 0;
  let responseCount = 0;
  let closedWithoutResponse = 0;
  let resolvedInPeriod = 0;
  const DELAY_THRESHOLD_MS = 15 * 60 * 1000;

  for (const cid of Object.keys(byContact)) {
    const msgs = byContact[cid];
    const contact = msgs[0]?.contact;
    if (!contact) continue;

    let hasAgentReply = false;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.direction === "out" && !m.senderUserId) autoReplies++;
      if (m.direction === "in") {
        const nextOut = msgs.slice(i + 1).find((x) => x.direction === "out");
        if (nextOut) {
          hasAgentReply = true;
          const diffMs = nextOut.at - m.at;
          if (diffMs > DELAY_THRESHOLD_MS) delayedMessages++;
          totalResponseMin += diffMs / 60000;
          responseCount++;
        } else if (event !== "outbound") {
          const elapsed = to ? to.getTime() - m.at.getTime() : Date.now() - m.at.getTime();
          if (elapsed > DELAY_THRESHOLD_MS) delayedMessages++;
        }
      }
    }

    if (contact.chatStatus === "resolved") {
      const lastInRange = msgs.filter((m) => inRange(m.at));
      if (lastInRange.length > 0) resolvedInPeriod++;
      if (!hasAgentReply && msgs.some((m) => m.direction === "in")) closedWithoutResponse++;
    }
  }

  if (event === "resolved") {
    // When filtering by resolved event, zero out unrelated counts
  }

  const avgResponseMinutes = responseCount ? Math.round(totalResponseMin / responseCount) : null;

  // Resolution time: first message to last message for resolved contacts
  let totalResolutionMin = 0;
  let resolutionCount = 0;
  for (const cid of Object.keys(byContact)) {
    const msgs = byContact[cid];
    const contact = msgs[0]?.contact;
    if (contact?.chatStatus !== "resolved" || msgs.length < 2) continue;
    const first = msgs[0].at;
    const last = msgs[msgs.length - 1].at;
    totalResolutionMin += (last - first) / 60000;
    resolutionCount++;
  }
  const avgResolutionMinutes = resolutionCount ? Math.round(totalResolutionMin / resolutionCount) : null;

  // Daily chart buckets
  const dayCount = from && to
    ? Math.max(1, Math.ceil((to - from) / (24 * 60 * 60 * 1000)))
    : 7;
  const chartDays = Math.min(dayCount, 30);
  const responseTimeChart = [];
  const resolutionTimeChart = [];
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (let i = chartDays - 1; i >= 0; i--) {
    const d = to ? new Date(to) : new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    if (from && d < from) continue;

    let dayRespTotal = 0, dayRespCount = 0, dayResTotal = 0, dayResCount = 0;

    for (const cid of Object.keys(byContact)) {
      const dayMsgs = byContact[cid].filter((m) => m.at >= d && m.at < next);
      if (!dayMsgs.length) continue;
      for (let j = 0; j < dayMsgs.length; j++) {
        if (dayMsgs[j].direction === "in") {
          const nextOut = byContact[cid].slice(byContact[cid].indexOf(dayMsgs[j]) + 1).find((x) => x.direction === "out");
          if (nextOut) {
            dayRespTotal += (nextOut.at - dayMsgs[j].at) / 60000;
            dayRespCount++;
          }
        }
      }
      const contact = byContact[cid][0]?.contact;
      if (contact?.chatStatus === "resolved" && dayMsgs.length >= 2) {
        dayResTotal += (dayMsgs[dayMsgs.length - 1].at - dayMsgs[0].at) / 60000;
        dayResCount++;
      }
    }

    const label = chartDays <= 7 ? days[d.getDay()] : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    responseTimeChart.push({ label, minutes: dayRespCount ? Math.round(dayRespTotal / dayRespCount) : 0 });
    resolutionTimeChart.push({ label, minutes: dayResCount ? Math.round(dayResTotal / dayResCount) : 0 });
  }

  // Agent stats
  const agentMap = {};
  for (const m of messages.filter((x) => x.direction === "out" && x.senderName)) {
    const name = m.senderName || "Agent";
    if (!agentMap[name]) agentMap[name] = { name, responses: 0, totalMin: 0 };
    agentMap[name].responses++;
  }
  const agents = await prisma.agent.findMany({ where: { companyId }, select: { id: true, name: true, color: true } });
  const agentStats = await Promise.all(
    agents.map(async (a) => ({
      name: a.name,
      color: a.color,
      responses: agentMap[a.name]?.responses || 0,
      assigned: await prisma.contact.count({ where: { companyId, assignedAgentId: a.id, chatStatus: { in: ["open", "pending"] } } }),
      resolved: await prisma.contact.count({ where: { companyId, assignedAgentId: a.id, chatStatus: "resolved" } }),
    }))
  );

  // Available tags (all company contacts)
  const allContacts = await prisma.contact.findMany({ where: { companyId }, select: { tags: true } });
  const tagSet = new Set();
  allContacts.forEach((c) => (c.tags || []).forEach((t) => tagSet.add(t)));

  const firstResponseRate = inboundMessages
    ? Math.round((responseCount / Math.max(1, messages.filter((m) => m.direction === "in").length)) * 100)
    : 0;

  // Automation message counts by source
  const autoWhere = {
    companyId,
    direction: "out",
    automationSource: { not: null },
    ...(from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(contactIds ? { contactId: { in: contactIds.length ? contactIds : ["__none__"] } } : {}),
  };
  const autoGroups = await prisma.message.groupBy({
    by: ["automationSource"],
    where: autoWhere,
    _count: { _all: true },
  });
  const autoCount = (src) => autoGroups.find((g) => g.automationSource === src)?._count._all || 0;
  const automationMessages = {
    outOfOffice: autoCount("away"),
    welcome: autoCount("welcome"),
    delayed: autoCount("delayed"),
    workflow: autoCount("workflow"),
    customReply: autoCount("custom_reply"),
  };

  return {
    kpis: {
      newConversations,
      openChats,
      pendingChats,
      resolved: event === "resolved" ? resolvedInPeriod : resolvedTotal,
      resolvedInPeriod,
      closedWithoutResponse,
      delayedMessages,
      autoReplies,
      avgResponseMinutes,
      avgResolutionMinutes,
      inboundMessages,
      outboundMessages,
      firstResponseRate,
      activeAutomations: automations,
    },
    automationMessages,
    responseTimeChart,
    resolutionTimeChart,
    agentStats,
    availableTags: Array.from(tagSet).sort(),
  };
}

router.get("/analytics/chat", async (req, res) => {
  const companyId = companyIdOf(req);
  const { preset, from: fromStr, to: toStr, event = "all", tag = "all" } = req.query;
  const { from, to } = parseReportDateRange(preset || "last7", fromStr, toStr);
  try {
    const data = await computeChatAnalytics(companyId, { from, to, event, tag });
    res.json({
      ...data,
      range: {
        preset: preset || "last7",
        from: from ? from.toISOString().slice(0, 10) : null,
        to: to ? to.toISOString().slice(0, 10) : null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load chat analytics" });
  }
});

router.get("/analytics", async (req, res) => {
  const tw = tenantWhere(req);
  const companyId = companyIdOf(req);
  const [contacts, agg, conversations] = await Promise.all([
    prisma.contact.count({ where: tw }),
    prisma.campaign.aggregate({ where: tw, _sum: { sent: true, delivered: true, read: true, replied: true }, _count: true }),
    buildConversations(req),
  ]);

  const sent = agg._sum.sent || 0;
  const delivered = agg._sum.delivered || 0;
  const read = agg._sum.read || 0;
  const replied = agg._sum.replied || 0;
  const openChats = conversations.filter((c) => c.unread > 0).length;
  const unreadInbox = conversations.reduce((s, c) => s + (c.unread || 0), 0);

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const series = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const [out, dels, reads] = await Promise.all([
      prisma.message.count({ where: { ...tw, direction: "out", at: { gte: d, lt: next } } }),
      prisma.message.count({ where: { ...tw, direction: "out", status: { in: ["delivered", "read"] }, at: { gte: d, lt: next } } }),
      prisma.message.count({ where: { ...tw, direction: "out", status: "read", at: { gte: d, lt: next } } }),
    ]);
    series.push({
      day: days[d.getDay()],
      label: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
      sent: out,
      delivered: dels,
      read: reads,
    });
  }

  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const hourly = [];
  for (const h of [0, 3, 6, 9, 12, 15, 18, 21]) {
    const a = new Date(startToday);
    a.setHours(h, 0, 0, 0);
    const b = new Date(a);
    b.setHours(h + 3, 0, 0, 0);
    const [hs, hd] = await Promise.all([
      prisma.message.count({ where: { ...tw, direction: "out", at: { gte: a, lt: b } } }),
      prisma.message.count({ where: { ...tw, direction: "out", status: { in: ["delivered", "read"] }, at: { gte: a, lt: b } } }),
    ]);
    const label = h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
    hourly.push({ hour: label, sent: hs, delivered: hd });
  }

  const [failed, templates, automations, flows, agents, integrations, lastMsgs, paid] = await Promise.all([
    prisma.message.count({ where: { ...tw, direction: "out", status: "failed" } }),
    prisma.template.count({ where: tw }),
    prisma.automation.count({ where: tw }),
    prisma.flow.count({ where: tw }),
    prisma.agent.count({ where: tw }),
    prisma.apiKey.count({ where: tw }).catch(() => 0),
    prisma.message.findMany({
      where: tw,
      orderBy: { at: "desc" },
      take: 8,
      include: { contact: { select: { name: true, phone: true } } },
    }),
    prisma.payment.aggregate({ where: { companyId: companyId || "__none__", status: "paid" }, _sum: { amount: true } }).catch(() => ({ _sum: { amount: 0 } })),
  ]);

  const spark = (key) => series.map((s) => s[key] || 0);

  res.json({
    kpis: {
      contacts,
      sent,
      delivered,
      deliveredRate: sent ? Math.round((delivered / sent) * 1000) / 10 : 0,
      readRate: sent ? Math.round((read / sent) * 1000) / 10 : 0,
      clickRate: sent ? Math.round((replied / sent) * 1000) / 10 : 0,
      replied,
      openChats,
      unreadInbox,
      campaigns: agg._count || 0,
      failed,
      revenuePaise: paid._sum?.amount || 0,
    },
    series,
    hourly,
    extras: { templates, automations, flows, agents, integrations, autoReplies: automations },
    feed: lastMsgs.map((m) => ({
      id: m.id,
      type: m.direction === "in" ? "inbound" : m.status,
      text: m.direction === "in" ? "New inbound message" : m.status === "read" ? "Message read" : m.status === "delivered" ? "Message delivered" : "Message sent",
      who: m.contact?.name || (m.contact?.phone ? `+${m.contact.phone}` : ""),
      at: m.at.getTime(),
    })),
    sparks: {
      contacts: spark("sent"),
      sent: spark("sent"),
      delivered: spark("delivered"),
      read: spark("read"),
      replied: spark("read"),
    },
    liveAt: Date.now(),
  });
});

function serializeTicket(t) {
  const company = t.company || null;
  const user = t.user || null;
  return {
    id: t.id,
    subject: t.subject,
    body: t.body,
    status: t.status,
    priority: t.priority,
    createdAt: t.createdAt.getTime(),
    updatedAt: t.updatedAt.getTime(),
    companyId: t.companyId,
    userId: t.userId,
    origin: t.origin || "client",
    adminReply: t.adminReply || "",
    client: {
      name: user?.name || company?.name || "—",
      email: user?.email || company?.email || "—",
      company: company?.name || "—",
      plan: company?.plan || null,
      phone: company?.phone || null,
    },
  };
}

router.get("/tickets", async (req, res) => {
  const companyId = companyIdOf(req);
  if (!companyId) return res.status(403).json({ error: "No workspace" });
  const tickets = await prisma.ticket.findMany({
    where: { companyId },
    include: { company: true, user: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(tickets.map(serializeTicket));
});

router.post("/tickets", async (req, res) => {
  const companyId = companyIdOf(req);
  if (!companyId) return res.status(403).json({ error: "No workspace" });
  const subject = String(req.body?.subject || "").trim();
  const body = String(req.body?.body || req.body?.message || "").trim();
  const priority = ["low", "normal", "high", "urgent"].includes(String(req.body?.priority || "").toLowerCase())
    ? String(req.body.priority).toLowerCase()
    : "normal";
  if (!subject) return res.status(400).json({ error: "Subject is required" });
  if (!body) return res.status(400).json({ error: "Message is required" });
  const ticket = await prisma.ticket.create({
    data: {
      companyId,
      userId: req.user.id,
      subject: subject.slice(0, 200),
      body: body.slice(0, 5000),
      priority,
      status: "open",
    },
    include: { company: true, user: true },
  });
  sendSupportTicketAlert({
    subject: ticket.subject,
    body: ticket.body,
    priority: ticket.priority,
    name: req.user.name,
    email: req.user.email,
    company: ticket.company?.name,
    plan: ticket.company?.plan,
  }).catch((e) => console.warn("[mail ticket]", e.message));
  notify({
    audience: "admin",
    title: "New support ticket",
    body: `${ticket.subject} · ${req.user.name || req.user.email}`,
    href: "/admin/tickets",
  }).catch(() => {});
  notify({
    audience: "client",
    companyId,
    userId: req.user.id,
    title: "Ticket opened",
    body: ticket.subject,
    href: "/dashboard/support",
  }).catch(() => {});
  res.status(201).json(serializeTicket(ticket));
});

router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("[api]", err?.message || err);
  res.status(500).json({ error: err?.message || "Server error" });
});

export default router;
