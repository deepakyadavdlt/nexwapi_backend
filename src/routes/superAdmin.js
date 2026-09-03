// routes/superAdmin.js — platform Super Admin APIs
import express from "express";
import { prisma } from "../lib/prisma.js";
import { buildSegmentContactWhere } from "../lib/segmentFilters.js";
import { requireAuth, requireSuperAdmin, signImpersonationToken, signToken, hashPassword } from "../lib/auth.js";
import { publicCompanyUser, uniqueSlug, uniquePartnerSlug, publicPartnerBranding } from "../lib/tenant.js";
import { createAgentSeat, ensureOwnerAgent } from "../lib/teamSeats.js";
import { CASHFREE_ENABLED } from "../lib/cashfree.js";
import { PLAN_CATALOG, normalizePlan, isPaidPlan } from "../lib/plans.js";
import { WA_LIVE } from "../config/whatsapp.js";
import { creditWallet, debitWallet, getPlatformPricing } from "../lib/wallet.js";
import { notify } from "../lib/notify.js";
import { hasPermission, permissionForPath, normalizePermissions, PERMISSIONS } from "../lib/permissions.js";
import { isExplicitTrue, normalizeHost, normalizeWebsiteUrl, assertUniqueCustomDomain, bumpPartnerCorsCache } from "../lib/partnerDomain.js";
import { sendPartnerActivated } from "../lib/mailer.js";
import multer from "multer";
import fs from "fs";
import path from "path";
import {
  fetchBusinessProfile, updateBusinessProfile, uploadProfilePicture, VERTICALS, platformWaCreds,
} from "../lib/waBusinessProfile.js";
import {
  applyPartnerBillingToAccount, partnerBillingConfig, partnerBillingReady,
} from "../lib/partnerBilling.js";
import {
  getPlatformCompanyId,
  buildPlatformConversations,
  platformPhoneDisplay,
} from "../lib/platformInbox.js";
import { sendText, uploadMedia, sendMediaById } from "../lib/whatsappService.js";
import { toMessage } from "../lib/prisma.js";

import { patchAsyncRouter } from "../lib/asyncRouter.js";

const router = express.Router();
patchAsyncRouter(router);
router.use(requireAuth, requireSuperAdmin);
router.use(async (req, res, next) => {
  try {
    const row = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { permissions: true, isActive: true, companyId: true, role: true },
    });
    if (!row || row.isActive === false) return res.status(403).json({ error: "Account disabled" });
    req.user.permissions = row.permissions;
    req.user.companyId = row.companyId;
    req.user.role = row.role;
    const key = permissionForPath(req.path);
    if (key && !hasPermission(req.user, key)) {
      return res.status(403).json({ error: "You do not have access to this section" });
    }
    next();
  } catch (e) {
    next(e);
  }
});
const profileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const UPLOAD_DIR = path.resolve("uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const inboxUpload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 100 * 1024 * 1024 } });

function waMediaType(mime) {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  return "document";
}

async function platformContactOr404(contactId, res) {
  const companyId = await getPlatformCompanyId();
  if (!companyId) {
    res.status(503).json({ error: "Platform inbox not configured" });
    return { companyId: null, contact: null };
  }
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, companyId },
    include: { assignedAgent: true },
  });
  if (!contact) {
    res.sendStatus(404);
    return { companyId, contact: null };
  }
  return { companyId, contact };
}

async function listPlatformAgents(companyId) {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      OR: [
        { role: "SUPER_ADMIN" },
        { role: "ADMIN", companyId: null },
      ],
    },
    select: { name: true, email: true },
  });
  for (const u of users) {
    if (!u.email) continue;
    await ensureOwnerAgent(companyId, { name: u.name || u.email, email: u.email }).catch(() => {});
  }
  return prisma.agent.findMany({
    where: { companyId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true, color: true, availability: true },
  });
}

const DAY_MS = 86400000;

function trialDaysLeft(c) {
  if (!c?.trialEndsAt) return null;
  return Math.max(0, Math.ceil((new Date(c.trialEndsAt).getTime() - Date.now()) / DAY_MS));
}

function mapClient(c) {
  const daysLeft = trialDaysLeft(c);
  const revenue = (c.payments || []).filter((p) => p.status === "paid").reduce((s, p) => s + p.amount, 0);
  return {
    id: c.id,
    name: c.name,
    email: c.email || c.users?.[0]?.email,
    ownerId: c.users?.[0]?.id,
    ownerName: c.users?.[0]?.name,
    status: c.status,
    plan: normalizePlan(c.plan),
    trialEndsAt: c.trialEndsAt ? new Date(c.trialEndsAt).getTime() : null,
    trialDaysLeft: daysLeft,
    trialExpired: c.status === "EXPIRED" || (c.status === "TRIAL" && daysLeft === 0),
    suspended: c.status === "SUSPENDED",
    freeAccess: Boolean(c.freeAccess),
    walletBalancePaise: c.walletBalancePaise || 0,
    messageCredits: c.messageCredits || 0,
    chatbotUsed: c.chatbotUsed,
    revenue,
    whatsappConnected: (c.whatsappAccounts || []).some((w) => w.isConnected),
    whatsappCount: (c.whatsappAccounts || []).length,
    onboardedAt: c.createdAt.getTime(),
    upgradedAt: c.upgradedAt ? c.upgradedAt.getTime() : null,
    lastActiveAt: c.lastActiveAt ? c.lastActiveAt.getTime() : null,
    phone: c.phone || "",
    website: c.website || "",
    partnerId: c.partnerId || c.partner?.id || null,
    partnerName: c.partner?.name || null,
  };
}

function serializePartner(p, extra = {}) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    email: p.email,
    phone: p.phone || "",
    status: p.status,
    maxClients: p.maxClients,
    paidAt: p.paidAt ? p.paidAt.getTime() : null,
    paymentNote: p.paymentNote || "",
    paymentAmount: p.paymentAmount || 0,
    productName: p.productName || "",
    logoUrl: p.logoUrl || null,
    primaryColor: p.primaryColor || "#0f8a3c",
    customDomain: p.customDomain || "",
    websiteUrl: p.websiteUrl || "",
    notes: p.notes || "",
    createdAt: p.createdAt.getTime(),
    branding: publicPartnerBranding(p),
    loginPath: `/login?partner=${p.slug}`,
    portalPath: `/p/${p.slug}`,
    clientCount: extra.clientCount ?? p._count?.companies ?? 0,
    ownerEmail: extra.ownerEmail || p.users?.[0]?.email || p.email,
    ownerName: extra.ownerName || p.users?.[0]?.name || p.name,
    ...extra,
  };
}

function notifyPartnerActivated(partner) {
  const to = partner.users?.[0]?.email || partner.email;
  if (!to) return;
  const dash = (process.env.APP_DASHBOARD_URL || "https://app.nexwapi.com").replace(/\/$/, "");
  sendPartnerActivated({
    to,
    name: partner.name,
    productName: partner.productName || partner.name,
    slug: partner.slug,
    loginUrl: `${dash}/partner`,
  }).catch((e) => console.warn("[partner activate mail]", e?.message || e));
}

/* ---------- Dashboard overview ---------- */
router.get("/overview", async (_req, res) => {
  const [companies, payments, messagesToday, campaigns, partnerCount] = await Promise.all([
    prisma.company.findMany({ include: { payments: true, whatsappAccounts: true, partner: true, users: { take: 1, orderBy: { createdAt: "asc" } } } }),
    prisma.payment.findMany({ where: { status: "paid" } }),
    prisma.message.count({
      where: { direction: "out", at: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
    }),
    prisma.campaign.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.partner.count().catch(() => 0),
  ]);

  const clients = companies.map(mapClient);
  const revenue = payments.reduce((s, p) => s + p.amount, 0);
  const paidThisMonth = payments.filter((p) => {
    const d = p.paidAt || p.createdAt;
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const mrr = paidThisMonth.reduce((s, p) => s + p.amount, 0);

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const series = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const [msgs, inbound, paid] = await Promise.all([
      prisma.message.count({ where: { direction: "out", at: { gte: d, lt: next } } }),
      prisma.message.count({ where: { direction: "in", at: { gte: d, lt: next } } }),
      prisma.payment.aggregate({ where: { status: "paid", paidAt: { gte: d, lt: next } }, _sum: { amount: true } }),
    ]);
    series.push({
      day: days[d.getDay()],
      label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      messages: msgs,
      inbound,
      revenue: paid._sum.amount || 0,
      rupees: Math.round((paid._sum.amount || 0) / 100),
    });
  }

  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const [inboundToday, openTickets] = await Promise.all([
    prisma.message.count({ where: { direction: "in", at: { gte: startToday } } }),
    prisma.ticket.count({ where: { status: { in: ["open", "pending"] } } }).catch(() => 0),
  ]);

  const planMix = {};
  for (const c of clients) {
    const key = c.plan || "trial";
    planMix[key] = (planMix[key] || 0) + 1;
  }

  res.json({
    summary: {
      total: clients.length,
      onTrial: clients.filter((c) => c.status === "TRIAL" && !c.trialExpired).length,
      active: clients.filter((c) => c.status === "ACTIVE").length,
      suspended: clients.filter((c) => c.suspended).length,
      expired: clients.filter((c) => c.trialExpired || c.status === "EXPIRED").length,
      revenue,
      mrr,
      arr: mrr * 12,
      messagesSentToday: messagesToday,
      inboundToday,
      openTickets,
      waConnected: clients.filter((c) => c.whatsappConnected).length,
      campaigns: campaigns.length,
      partners: partnerCount,
    },
    planMix,
    topClients: [...clients].sort((a, b) => b.revenue - a.revenue).slice(0, 6),
    topCampaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      sent: c.sent,
      delivered: c.delivered,
      read: c.read,
      status: c.status,
      companyId: c.companyId,
    })),
    series,
    liveAt: Date.now(),
  });
});

/* ---------- Partners (agencies) ---------- */
router.get("/partners", async (_req, res) => {
  const rows = await prisma.partner.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { companies: true } }, users: { where: { role: "PARTNER" }, take: 1, orderBy: { createdAt: "asc" } } },
  });
  res.json({
    partners: rows.map((p) => serializePartner(p)),
    summary: {
      total: rows.length,
      active: rows.filter((p) => p.status === "ACTIVE").length,
      pending: rows.filter((p) => p.status === "PENDING").length,
      suspended: rows.filter((p) => p.status === "SUSPENDED").length,
    },
  });
});

router.post("/partners", async (req, res) => {
  if (req.user.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Only Super Admin can create partners" });
  }
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").toLowerCase().trim();
  const password = String(req.body?.password || "");
  const phone = String(req.body?.phone || "").trim();
  const productName = String(req.body?.productName || "").trim();
  const maxClients = Math.max(1, Math.min(10000, Number(req.body?.maxClients) || 50));
  const activate = isExplicitTrue(req.body?.activate) || isExplicitTrue(req.body?.paid);
  const paymentNote = String(req.body?.paymentNote || "").trim();
  const paymentAmount = Math.max(0, Math.floor(Number(req.body?.paymentAmount || req.body?.paymentAmountPaise) || 0));
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "An account with this email already exists" });
  try {
    const slug = await uniquePartnerSlug(req.body?.slug || name);
    const partner = await prisma.partner.create({
      data: {
        name,
        slug,
        email,
        phone: phone || null,
        status: activate ? "ACTIVE" : "PENDING",
        plan: String(req.body?.plan || "agency").slice(0, 40),
        maxClients,
        productName: productName || name,
        websiteUrl: normalizeWebsiteUrl(req.body?.websiteUrl || ""),
        primaryColor: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(req.body?.primaryColor || ""))
          ? String(req.body.primaryColor)
          : "#0f8a3c",
        paidAt: activate ? new Date() : null,
        paymentNote: paymentNote || (activate ? "Marked paid by Super Admin" : null),
        paymentAmount,
        notes: String(req.body?.notes || "").trim() || null,
      },
    });
    const owner = await prisma.user.create({
      data: {
        name,
        email,
        phone: phone || null,
        password: await hashPassword(password),
        role: "PARTNER",
        companyId: null,
        partnerId: partner.id,
        isActive: true,
      },
    });
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: "partner_create",
        entity: "Partner",
        entityId: partner.id,
        meta: { email, activate, maxClients },
      },
    }).catch(() => {});
    res.status(201).json({
      ok: true,
      partner: serializePartner(partner, { clientCount: 0, ownerEmail: owner.email, ownerName: owner.name }),
    });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Email or slug already exists" });
    res.status(400).json({ error: e.message || "Could not create partner" });
  }
});

router.patch("/partners/:id", async (req, res) => {
  const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
  if (!partner) return res.status(404).json({ error: "not found" });
  const data = {};
  if (req.body?.name != null) data.name = String(req.body.name).trim();
  if (req.body?.email != null) data.email = String(req.body.email).toLowerCase().trim();
  if (req.body?.phone != null) data.phone = String(req.body.phone).trim() || null;
  if (req.body?.productName != null) data.productName = String(req.body.productName).trim();
  if (req.body?.maxClients != null) data.maxClients = Math.max(1, Math.min(10000, Number(req.body.maxClients) || partner.maxClients));
  if (req.body?.notes != null) data.notes = String(req.body.notes).trim() || null;
  if (req.body?.logoUrl != null) data.logoUrl = String(req.body.logoUrl).trim() || null;
  if (req.body?.websiteUrl != null) data.websiteUrl = normalizeWebsiteUrl(req.body.websiteUrl);
  if (req.body?.customDomain != null) {
    const host = String(req.body.customDomain).trim() ? normalizeHost(req.body.customDomain) : null;
    if (String(req.body.customDomain).trim() && !host) {
      return res.status(400).json({ error: "Enter a valid domain like crm.yourcompany.com." });
    }
    try {
      await assertUniqueCustomDomain(prisma, host, partner.id);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    data.customDomain = host;
  }
  if (req.body?.plan != null) data.plan = String(req.body.plan).trim().slice(0, 40);
  if (req.body?.primaryColor && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(req.body.primaryColor))) {
    data.primaryColor = String(req.body.primaryColor);
  }
  const updated = await prisma.partner.update({ where: { id: partner.id }, data });
  bumpPartnerCorsCache();
  if (req.body?.password && String(req.body.password).length >= 6) {
    await prisma.user.updateMany({
      where: { partnerId: partner.id, role: "PARTNER" },
      data: { password: await hashPassword(String(req.body.password)) },
    });
  }
  const withCount = await prisma.partner.findUnique({
    where: { id: updated.id },
    include: { _count: { select: { companies: true } }, users: { where: { role: "PARTNER" }, take: 1 } },
  });
  res.json(serializePartner(withCount));
});

router.post("/partners/:id/activate", async (req, res) => {
  const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
  if (!partner) return res.status(404).json({ error: "not found" });
  const paymentNote = String(req.body?.paymentNote || "Payment received").trim();
  const paymentAmount = Math.max(0, Math.floor(Number(req.body?.paymentAmount || req.body?.paymentAmountPaise) || partner.paymentAmount || 0));
  const updated = await prisma.partner.update({
    where: { id: partner.id },
    data: {
      status: "ACTIVE",
      paidAt: partner.paidAt || new Date(),
      paymentNote,
      paymentAmount,
    },
    include: { _count: { select: { companies: true } }, users: { where: { role: "PARTNER" }, take: 1 } },
  });
  await prisma.auditLog.create({
    data: { userId: req.user.id, action: "partner_activate", entity: "Partner", entityId: partner.id, meta: { paymentNote, paymentAmount } },
  }).catch(() => {});
  bumpPartnerCorsCache();
  notifyPartnerActivated(updated);
  res.json(serializePartner(updated));
});

router.post("/partners/:id/suspend", async (req, res) => {
  const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
  if (!partner) return res.status(404).json({ error: "not found" });
  const updated = await prisma.partner.update({
    where: { id: partner.id },
    data: { status: "SUSPENDED", notes: req.body?.reason ? String(req.body.reason).trim() : partner.notes },
    include: { _count: { select: { companies: true } }, users: { where: { role: "PARTNER" }, take: 1 } },
  });
  bumpPartnerCorsCache();
  res.json(serializePartner(updated));
});

router.post("/partners/:id/unsuspend", async (req, res) => {
  const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
  if (!partner) return res.status(404).json({ error: "not found" });
  const status = partner.paidAt ? "ACTIVE" : "PENDING";
  const updated = await prisma.partner.update({
    where: { id: partner.id },
    data: { status },
    include: { _count: { select: { companies: true } }, users: { where: { role: "PARTNER" }, take: 1 } },
  });
  res.json(serializePartner(updated));
});

router.get("/partners/:id/clients", async (req, res) => {
  const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
  if (!partner) return res.status(404).json({ error: "not found" });
  const companies = await prisma.company.findMany({
    where: { partnerId: partner.id },
    orderBy: { createdAt: "desc" },
    include: { payments: true, whatsappAccounts: true, partner: true, users: { take: 1, orderBy: { createdAt: "asc" } } },
  });
  res.json({ partner: serializePartner(partner, { clientCount: companies.length }), clients: companies.map(mapClient) });
});

router.post("/partners/:id/login-as", async (req, res) => {
  const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
  if (!partner) return res.status(404).json({ error: "not found" });
  const owner = await prisma.user.findFirst({ where: { partnerId: partner.id, role: "PARTNER" }, orderBy: { createdAt: "asc" } });
  if (!owner) return res.status(404).json({ error: "No partner login on this agency" });
  const token = signToken(owner, { impersonatedBy: req.user.id, impersonating: true });
  await prisma.auditLog.create({
    data: { userId: req.user.id, action: "partner_login_as", entity: "Partner", entityId: partner.id },
  }).catch(() => {});
  res.json({
    token,
    user: {
      ...publicCompanyUser(owner, null),
      isPartner: true,
      partnerId: partner.id,
      impersonating: true,
      impersonatedBy: req.user.id,
    },
  });
});

/* ---------- Clients ---------- */
router.get("/clients", async (req, res) => {
  const partnerId = String(req.query?.partnerId || "").trim();
  const withOwners = await prisma.company.findMany({
    where: partnerId ? { partnerId } : {},
    orderBy: { createdAt: "desc" },
    include: {
      payments: true,
      whatsappAccounts: true,
      partner: true,
      users: { take: 5, orderBy: { createdAt: "asc" } },
    },
  });
  const clients = withOwners.map((c) => {
    const owner = c.users.find((u) => u.role === "OWNER" || u.role === "ADMIN") || c.users[0];
    return mapClient({ ...c, users: owner ? [owner] : [] });
  });
  const summary = {
    total: clients.length,
    onTrial: clients.filter((c) => c.status === "TRIAL" && !c.trialExpired).length,
    pro: clients.filter((c) => c.plan === "growth" || c.plan === "starter").length,
    starter: clients.filter((c) => c.plan === "starter").length,
    growth: clients.filter((c) => c.plan === "growth").length,
    expired: clients.filter((c) => c.trialExpired || c.status === "EXPIRED").length,
    suspended: clients.filter((c) => c.suspended).length,
    revenue: clients.reduce((s, c) => s + c.revenue, 0),
  };
  res.json({ clients, summary });
});

router.post("/clients", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").toLowerCase().trim();
  const password = String(req.body?.password || "");
  const companyName = String(req.body?.company || req.body?.companyName || name).trim();
  const phone = String(req.body?.phone || "").trim();
  const plan = normalizePlan(req.body?.plan || "trial");
  const credits = Math.max(0, Number(req.body?.credits) || 0);
  const partnerId = String(req.body?.partnerId || "").trim() || null;
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  if (password && password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "An account with this email already exists" });
  if (partnerId) {
    const partnerRow = await prisma.partner.findUnique({ where: { id: partnerId } });
    if (!partnerRow) return res.status(400).json({ error: "Partner not found" });
  }
  try {
    const pricing = await getPlatformPricing();
    const slug = await uniqueSlug(companyName);
    const paid = isPaidPlan(plan);
    const trialEndsAt = paid ? null : new Date(Date.now() + 7 * DAY_MS);
    const company = await prisma.company.create({
      data: {
        name: companyName,
        slug,
        email,
        phone: phone || null,
        status: paid ? "ACTIVE" : "TRIAL",
        plan: ["trial", "starter", "growth", "professional", "enterprise"].includes(plan) ? plan : "trial",
        trialEndsAt,
        trialStartedAt: paid ? null : new Date(),
        messageCredits: credits || pricing.trialCredits,
        walletBalancePaise: 0,
        freeAccess: Boolean(req.body?.freeAccess),
        partnerId,
      },
    });
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: await hashPassword(password || Math.random().toString(36).slice(-10) + "Aa1"),
        phone: phone || null,
        role: "OWNER",
        companyId: company.id,
      },
    });
    await prisma.subscription.create({
      data: {
        companyId: company.id,
        plan: company.plan,
        status: "active",
        trialEndsAt,
        amount: PLAN_CATALOG[company.plan]?.amount || 0,
      },
    });
    await prisma.setting.create({ data: { companyId: company.id, businessName: companyName, autoAssign: true } });
    await ensureOwnerAgent(company.id, { name, email }).catch(() => {});
    await prisma.auditLog.create({
      data: {
        companyId: company.id,
        userId: req.user.id,
        action: "client_create",
        entity: "Company",
        entityId: company.id,
        meta: { email, plan: company.plan },
      },
    }).catch(() => {});
    notify({
      audience: "admin",
      title: "New client created",
      body: `${company.name} · ${email}`,
      href: "/admin/clients",
    }).catch(() => {});
    res.status(201).json({ ok: true, company, owner: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Email or company already exists" });
    res.status(400).json({ error: e.message || "Could not create client" });
  }
});

router.patch("/clients/:id", async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id }, include: { users: { orderBy: { createdAt: "asc" } } } });
  if (!company) return res.status(404).json({ error: "not found" });
  const data = {};
  if (req.body?.name != null) data.name = String(req.body.name).trim();
  if (req.body?.email != null) data.email = String(req.body.email).toLowerCase().trim();
  if (req.body?.phone != null) data.phone = String(req.body.phone).trim() || null;
  if (req.body?.website != null) data.website = String(req.body.website).trim() || null;
  const updated = await prisma.company.update({ where: { id: company.id }, data });
  const owner = company.users.find((u) => u.role === "OWNER" || u.role === "ADMIN") || company.users[0];
  if (owner) {
    const ud = {};
    if (req.body?.ownerName) ud.name = String(req.body.ownerName).trim();
    if (req.body?.email) ud.email = String(req.body.email).toLowerCase().trim();
    if (req.body?.phone != null) ud.phone = String(req.body.phone).trim() || null;
    if (req.body?.password && String(req.body.password).length >= 6) ud.password = await hashPassword(String(req.body.password));
    if (Object.keys(ud).length) await prisma.user.update({ where: { id: owner.id }, data: ud });
  }
  await prisma.auditLog.create({
    data: { companyId: company.id, userId: req.user.id, action: "client_update", entity: "Company", entityId: company.id, meta: data },
  }).catch(() => {});
  res.json(updated);
});

router.delete("/clients/:id", async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not found" });
  await prisma.company.delete({ where: { id: company.id } });
  await prisma.auditLog.create({
    data: { userId: req.user.id, action: "client_delete", entity: "Company", entityId: company.id, meta: { name: company.name, email: company.email } },
  }).catch(() => {});
  res.json({ ok: true });
});

router.post("/clients/:id/plan", async (req, res) => {
  let { plan } = req.body || {};
  plan = normalizePlan(plan === "pro" ? "growth" : plan);
  if (!["trial", "starter", "growth", "professional", "enterprise", "expired"].includes(plan)) {
    return res.status(400).json({ error: "invalid plan" });
  }
  const data = { plan };
  if (isPaidPlan(plan)) {
    data.status = "ACTIVE";
    data.upgradedAt = new Date();
    data.trialEndsAt = null;
  } else if (plan === "trial") {
    data.status = "TRIAL";
    data.trialEndsAt = new Date(Date.now() + 7 * DAY_MS);
    data.trialStartedAt = new Date();
  } else {
    data.status = "EXPIRED";
  }
  const company = await prisma.company.update({ where: { id: req.params.id }, data });
  await prisma.subscription.upsert({
    where: { companyId: company.id },
    update: { plan, status: "active", amount: PLAN_CATALOG[plan]?.amount || 0 },
    create: {
      companyId: company.id,
      plan,
      status: "active",
      amount: PLAN_CATALOG[plan]?.amount || 0,
      trialEndsAt: company.trialEndsAt,
    },
  }).catch(() => {});
  if (isPaidPlan(plan) || plan === "trial") {
    const { applyPlanCredits } = await import("../lib/wallet.js");
    await applyPlanCredits(company.id, plan, req.user.id).catch(() => {});
  }
  await prisma.auditLog.create({
    data: { companyId: company.id, userId: req.user.id, action: "plan_change", entity: "Company", entityId: company.id, meta: { plan } },
  }).catch(() => {});
  res.json(company);
});

router.post("/clients/:id/team-user", async (req, res) => {
  const { name, email, role = "Agent", password } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  try {
    const { agent, login } = await createAgentSeat(req.params.id, { name, email, role, password });
    res.status(201).json({
      ok: true,
      agent,
      loginEmail: login.email,
      tempPassword: login.password,
      message: login.password
        ? `Login created. Email: ${login.email}  Password: ${login.password}`
        : "User already had a login. Agent seat added.",
    });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "This email is already a team member" });
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code, limit: e.limit, used: e.used });
    res.status(400).json({ error: e.message });
  }
});

router.post("/clients/:id/suspend", async (req, res) => {
  const reason = req.body?.reason || "Payment overdue";
  const company = await prisma.company.update({
    where: { id: req.params.id },
    data: { status: "SUSPENDED", suspendedAt: new Date(), suspendReason: reason },
  });
  await prisma.auditLog.create({
    data: { companyId: company.id, userId: req.user.id, action: "suspend", entity: "Company", entityId: company.id, meta: { reason } },
  }).catch(() => {});
  res.json(company);
});

router.post("/clients/:id/unsuspend", async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not found" });
  const status = company.plan === "trial" ? "TRIAL" : company.plan === "expired" ? "EXPIRED" : "ACTIVE";
  const updated = await prisma.company.update({
    where: { id: company.id },
    data: { status, suspendedAt: null, suspendReason: null },
  });
  res.json(updated);
});

/** Super Admin: grant free access (no payment) + optional credits / days */
router.post("/clients/:id/free-access", async (req, res) => {
  const { enabled = true, credits = 0, days = 0, note = "", plan } = req.body || {};
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not found" });

  const data = {
    freeAccess: Boolean(enabled),
    freeAccessNote: note || (enabled ? "Granted by Super Admin" : null),
  };
  if (enabled) {
    data.status = "ACTIVE";
    data.suspendedAt = null;
    if (plan && ["trial", "starter", "growth"].includes(normalizePlan(plan))) {
      data.plan = normalizePlan(plan);
    }
    if (days > 0) {
      data.trialEndsAt = new Date(Date.now() + Number(days) * DAY_MS);
      data.plan = data.plan || "trial";
    }
  }

  let updated = await prisma.company.update({ where: { id: company.id }, data });

  const addCredits = Number(credits) || 0;
  if (enabled && addCredits > 0) {
    const r = await creditWallet({
      companyId: company.id,
      amountPaise: 0,
      credits: addCredits,
      reason: "admin_grant",
      createdBy: req.user.id,
      meta: { note },
    });
    updated = r.company;
    await prisma.payment.create({
      data: {
        companyId: company.id,
        plan: updated.plan,
        type: "admin_grant",
        amount: 0,
        status: "paid",
        creditsAdded: addCredits,
        paidAt: new Date(),
        invoiceNo: `FREE-${Date.now().toString(36)}`,
      },
    }).catch(() => {});
  }

  await prisma.auditLog.create({
    data: {
      companyId: company.id,
      userId: req.user.id,
      action: enabled ? "free_access_grant" : "free_access_revoke",
      entity: "Company",
      entityId: company.id,
      meta: { credits: addCredits, days, note },
    },
  }).catch(() => {});

  res.json(updated);
});

/** Super Admin: top-up wallet / credits for a client */
router.post("/clients/:id/wallet-credit", async (req, res) => {
  const amountPaise = Math.max(0, Math.floor(Number(req.body?.amountPaise) || 0));
  const credits = Math.max(0, Math.floor(Number(req.body?.credits) || 0));
  const note = String(req.body?.note || "").trim();
  if (!amountPaise && !credits) return res.status(400).json({ error: "amountPaise or credits required" });
  if (credits > 10_000_000 || amountPaise > 100_000_000) {
    return res.status(400).json({ error: "Amount is too large" });
  }
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not found" });
  const r = await creditWallet({
    companyId: company.id,
    amountPaise,
    credits,
    reason: "admin_grant",
    createdBy: req.user.id,
    meta: { note: note || "Admin credit" },
  });
  await prisma.auditLog.create({
    data: {
      companyId: company.id,
      userId: req.user.id,
      action: "wallet_credit",
      entity: "Company",
      entityId: company.id,
      meta: { credits, amountPaise, note, creditsAfter: r.company.messageCredits },
    },
  }).catch(() => {});
  notify({
    audience: "client",
    companyId: company.id,
    title: "Credits added",
    body: credits
      ? `Admin credited ${credits.toLocaleString()} message credits.${note ? " " + note : ""}`
      : `Admin added wallet funds.${note ? " " + note : ""}`,
    href: "/dashboard/wallet",
  }).catch(() => {});
  res.json({
    walletBalancePaise: r.company.walletBalancePaise,
    messageCredits: r.company.messageCredits,
    txn: r.txn,
  });
});

/** Super Admin: debit / claw back wallet / credits */
router.post("/clients/:id/wallet-debit", async (req, res) => {
  const amountPaise = Math.max(0, Math.floor(Number(req.body?.amountPaise) || 0));
  const credits = Math.max(0, Math.floor(Number(req.body?.credits) || 0));
  const note = String(req.body?.note || "").trim();
  if (!amountPaise && !credits) return res.status(400).json({ error: "amountPaise or credits required" });
  if (!note) return res.status(400).json({ error: "Note is required for debit" });
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not found" });
  try {
    const r = await debitWallet({
      companyId: company.id,
      amountPaise,
      credits,
      reason: "admin_debit",
      createdBy: req.user.id,
      meta: { note },
    });
    await prisma.auditLog.create({
      data: {
        companyId: company.id,
        userId: req.user.id,
        action: "wallet_debit",
        entity: "Company",
        entityId: company.id,
        meta: { credits, amountPaise, note, creditsAfter: r.company.messageCredits },
      },
    }).catch(() => {});
    notify({
      audience: "client",
      companyId: company.id,
      title: "Credits deducted",
      body: credits
        ? `Admin deducted ${credits.toLocaleString()} message credits. ${note}`
        : `Admin deducted wallet funds. ${note}`,
      href: "/dashboard/wallet",
    }).catch(() => {});
    res.json({
      walletBalancePaise: r.company.walletBalancePaise,
      messageCredits: r.company.messageCredits,
      txn: r.txn,
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code, available: e.available });
  }
});

router.get("/clients/:id/wallet", async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not found" });
  const txns = await prisma.walletTransaction.findMany({
    where: { companyId: company.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const payments = await prisma.payment.findMany({
    where: { companyId: company.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({
    walletBalancePaise: company.walletBalancePaise,
    messageCredits: company.messageCredits,
    freeAccess: company.freeAccess,
    transactions: txns,
    payments,
  });
});

router.get("/pricing", async (_req, res) => {
  res.json(await getPlatformPricing());
});

router.patch("/pricing", async (req, res) => {
  const body = req.body || {};
  const pricing = await prisma.platformSetting.upsert({
    where: { id: "default" },
    update: {
      ...(body.creditsPerRupee != null && { creditsPerRupee: Number(body.creditsPerRupee) }),
      ...(body.creditPerOutbound != null && { creditPerOutbound: Number(body.creditPerOutbound) }),
      ...(body.creditPerInbound != null && { creditPerInbound: Number(body.creditPerInbound) }),
      ...(body.trialCredits != null && { trialCredits: Number(body.trialCredits) }),
      ...(body.starterCredits != null && { starterCredits: Number(body.starterCredits) }),
      ...(body.growthCredits != null && { growthCredits: Number(body.growthCredits) }),
    },
    create: { id: "default", ...body },
  });
  res.json(pricing);
});

router.post("/clients/:id/trial", async (req, res) => {
  const { days = 7, action = "extend" } = req.body || {};
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not found" });

  if (action === "stop") {
    const updated = await prisma.company.update({
      where: { id: company.id },
      data: { status: "EXPIRED", plan: "expired", trialEndsAt: new Date() },
    });
    return res.json(updated);
  }

  const base = company.trialEndsAt && new Date(company.trialEndsAt) > new Date()
    ? new Date(company.trialEndsAt)
    : new Date();
  const trialEndsAt = new Date(base.getTime() + Number(days) * DAY_MS);
  const updated = await prisma.company.update({
    where: { id: company.id },
    data: { status: "TRIAL", plan: "trial", trialEndsAt, trialStartedAt: company.trialStartedAt || new Date() },
  });
  res.json(updated);
});

/* ---------- Login as client ---------- */
router.post("/clients/:id/login-as", async (req, res) => {
  const company = await prisma.company.findUnique({
    where: { id: req.params.id },
    include: { users: { orderBy: { createdAt: "asc" } }, partner: true },
  });
  if (!company) return res.status(404).json({ error: "Client not found" });
  const owner = company.users.find((u) => u.role === "OWNER" || u.role === "Owner") || company.users[0];
  if (!owner) return res.status(404).json({ error: "No user on this company" });
  const token = signImpersonationToken(req.user, owner);
  await prisma.auditLog.create({
    data: {
      companyId: company.id,
      userId: req.user.id,
      action: "login_as",
      entity: "User",
      entityId: owner.id,
    },
  }).catch(() => {});
  res.json({
    token,
    user: { ...publicCompanyUser(owner, company), impersonating: true, impersonatedBy: req.user.id },
  });
});

function partnerInclude() {
  return { users: { where: { role: "PARTNER" }, take: 3, orderBy: { createdAt: "asc" } }, _count: { select: { companies: true } } };
}

router.get("/partners", async (_req, res) => {
  const rows = await prisma.partner.findMany({
    orderBy: { createdAt: "desc" },
    include: partnerInclude(),
  });
  res.json({
    partners: rows.map((p) => serializePartner(p)),
    summary: {
      total: rows.length,
      active: rows.filter((p) => p.status === "ACTIVE").length,
      pending: rows.filter((p) => p.status === "PENDING").length,
      suspended: rows.filter((p) => p.status === "SUSPENDED").length,
      clients: rows.reduce((s, p) => s + (p._count?.companies || 0), 0),
    },
  });
});

router.post("/partners", async (req, res) => {
  if (req.user.role !== "SUPER_ADMIN" && req.user.role !== "SuperAdmin") {
    return res.status(403).json({ error: "Only Super Admin can create partners" });
  }
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").toLowerCase().trim();
  const password = String(req.body?.password || "");
  const ownerName = String(req.body?.ownerName || name).trim();
  const phone = String(req.body?.phone || "").trim();
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "An account with this email already exists" });
  const activate = isExplicitTrue(req.body?.activate) || isExplicitTrue(req.body?.paid);
  const slug = await uniquePartnerSlug(req.body?.slug || name);
  const partner = await prisma.partner.create({
    data: {
      name,
      slug,
      email,
      phone: phone || null,
      status: activate ? "ACTIVE" : "PENDING",
      maxClients: Math.max(1, Number(req.body?.maxClients) || 50),
      paidAt: activate ? new Date() : null,
      paymentNote: String(req.body?.paymentNote || "").trim() || (activate ? "Marked paid by Super Admin" : null),
      paymentAmount: Math.max(0, Math.floor(Number(req.body?.paymentAmount) || 0)),
      productName: String(req.body?.productName || name).trim(),
      logoUrl: String(req.body?.logoUrl || "").trim() || null,
      primaryColor: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(req.body?.primaryColor || ""))
        ? String(req.body.primaryColor)
        : "#0f8a3c",
      notes: String(req.body?.notes || "").trim() || null,
    },
  });
  const user = await prisma.user.create({
    data: {
      name: ownerName,
      email,
      password: await hashPassword(password),
      phone: phone || null,
      role: "PARTNER",
      companyId: null,
      partnerId: partner.id,
      isActive: true,
    },
  });
  await prisma.auditLog.create({
    data: {
      userId: req.user.id,
      action: "partner_create",
      entity: "Partner",
      entityId: partner.id,
      meta: { email, activate, slug },
    },
  }).catch(() => {});
  res.status(201).json({
    ok: true,
    partner: serializePartner(partner, { clientCount: 0, ownerEmail: user.email, ownerName: user.name }),
  });
});

router.patch("/partners/:id", async (req, res) => {
  const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
  if (!partner) return res.status(404).json({ error: "not found" });
  const data = {};
  if (req.body?.name != null) data.name = String(req.body.name).trim();
  if (req.body?.email != null) data.email = String(req.body.email).toLowerCase().trim();
  if (req.body?.phone != null) data.phone = String(req.body.phone).trim() || null;
  if (req.body?.maxClients != null) data.maxClients = Math.max(1, Number(req.body.maxClients) || partner.maxClients);
  if (req.body?.productName != null) data.productName = String(req.body.productName).trim();
  if (req.body?.logoUrl != null) data.logoUrl = String(req.body.logoUrl).trim() || null;
  if (req.body?.primaryColor && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(req.body.primaryColor))) {
    data.primaryColor = String(req.body.primaryColor);
  }
  if (req.body?.customDomain != null) data.customDomain = String(req.body.customDomain).trim().toLowerCase() || null;
  if (req.body?.notes != null) data.notes = String(req.body.notes).trim() || null;
  if (req.body?.paymentNote != null) data.paymentNote = String(req.body.paymentNote).trim() || null;
  if (req.body?.paymentAmount != null) data.paymentAmount = Math.max(0, Math.floor(Number(req.body.paymentAmount) || 0));
  const updated = await prisma.partner.update({ where: { id: partner.id }, data, include: partnerInclude() });
  bumpPartnerCorsCache();
  if (req.body?.ownerPassword && String(req.body.ownerPassword).length >= 6) {
    const owner = updated.users[0];
    if (owner) await prisma.user.update({ where: { id: owner.id }, data: { password: await hashPassword(String(req.body.ownerPassword)) } });
  }
  res.json(serializePartner(updated));
});

router.post("/partners/:id/activate", async (req, res) => {
  const partner = await prisma.partner.findUnique({ where: { id: req.params.id }, include: partnerInclude() });
  if (!partner) return res.status(404).json({ error: "not found" });
  const updated = await prisma.partner.update({
    where: { id: partner.id },
    data: {
      status: "ACTIVE",
      paidAt: partner.paidAt || new Date(),
      paymentNote: String(req.body?.paymentNote || partner.paymentNote || "Activated by Super Admin").trim(),
      paymentAmount: req.body?.paymentAmount != null ? Math.max(0, Math.floor(Number(req.body.paymentAmount) || 0)) : partner.paymentAmount,
    },
    include: partnerInclude(),
  });
  const owner = updated.users[0];
  if (owner && owner.isActive === false) {
    await prisma.user.update({ where: { id: owner.id }, data: { isActive: true } });
  }
  await prisma.auditLog.create({
    data: { userId: req.user.id, action: "partner_activate", entity: "Partner", entityId: partner.id, meta: { paymentNote: updated.paymentNote } },
  }).catch(() => {});
  bumpPartnerCorsCache();
  notifyPartnerActivated(updated);
  res.json(serializePartner(updated));
});

router.post("/partners/:id/suspend", async (req, res) => {
  const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
  if (!partner) return res.status(404).json({ error: "not found" });
  const updated = await prisma.partner.update({
    where: { id: partner.id },
    data: { status: "SUSPENDED", notes: String(req.body?.reason || partner.notes || "Suspended").trim() },
    include: partnerInclude(),
  });
  res.json(serializePartner(updated));
});

router.post("/partners/:id/unsuspend", async (req, res) => {
  const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
  if (!partner) return res.status(404).json({ error: "not found" });
  const updated = await prisma.partner.update({
    where: { id: partner.id },
    data: { status: partner.paidAt ? "ACTIVE" : "PENDING" },
    include: partnerInclude(),
  });
  res.json(serializePartner(updated));
});

router.post("/partners/:id/login-as", async (req, res) => {
  const partner = await prisma.partner.findUnique({
    where: { id: req.params.id },
    include: { users: { where: { role: "PARTNER" }, orderBy: { createdAt: "asc" } } },
  });
  if (!partner) return res.status(404).json({ error: "Partner not found" });
  const owner = partner.users[0];
  if (!owner) return res.status(404).json({ error: "No partner login on this account" });
  if (owner.role === "SUPER_ADMIN") return res.status(403).json({ error: "Cannot impersonate Super Admin" });
  const token = signImpersonationToken(req.user, owner);
  res.json({
    token,
    user: {
      id: owner.id,
      name: owner.name,
      email: owner.email,
      role: "PARTNER",
      partnerId: partner.id,
      isPartner: true,
      isSuperAdmin: false,
      isPlatformStaff: false,
      impersonating: true,
      impersonatedBy: req.user.id,
    },
  });
});

router.get("/partners/:id/clients", async (req, res) => {
  const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
  if (!partner) return res.status(404).json({ error: "not found" });
  const withOwners = await prisma.company.findMany({
    where: { partnerId: partner.id },
    orderBy: { createdAt: "desc" },
    include: { payments: true, whatsappAccounts: true, partner: true, users: { take: 5, orderBy: { createdAt: "asc" } } },
  });
  const clients = withOwners.map((c) => {
    const owner = c.users.find((u) => u.role === "OWNER" || u.role === "ADMIN") || c.users[0];
    return mapClient({ ...c, users: owner ? [owner] : [] });
  });
  res.json({ partner: serializePartner(partner, { clientCount: clients.length }), clients });
});

/* ---------- WhatsApp accounts ---------- */
router.get("/whatsapp-accounts", async (_req, res) => {
  const accounts = await prisma.whatsAppAccount.findMany({
    orderBy: { createdAt: "desc" },
    include: { company: { select: { id: true, name: true, status: true, plan: true } } },
  });
  const cfg = partnerBillingConfig();
  res.json(
    accounts.map((a) => ({
      id: a.id,
      companyId: a.companyId,
      companyName: a.company?.name,
      businessName: a.businessName || a.verifiedName,
      phoneNumber: a.displayPhoneNumber || a.phoneNumber,
      wabaId: a.wabaId,
      businessId: a.businessId,
      qualityRating: a.qualityRating || "UNKNOWN",
      messagingLimit: a.messagingLimit || "—",
      verificationStatus: a.verificationStatus || "unverified",
      webhookStatus: a.webhookStatus,
      connectedSince: a.connectedAt ? a.connectedAt.getTime() : null,
      isConnected: a.isConnected,
      status: a.status,
      lastError: a.lastError,
      billingCurrency: a.billingCurrency || null,
      partnerBillingAt: a.partnerBillingAt ? a.partnerBillingAt.getTime() : null,
      billingReady: Boolean(a.billingCurrency),
      billingUrl: a.businessId && a.wabaId
        ? `https://business.facebook.com/billing_hub/accounts/details/?business_id=${encodeURIComponent(a.businessId)}&asset_id=${encodeURIComponent(a.wabaId)}&wizard_id=business-account`
        : null,
    }))
  );
});

router.get("/whatsapp/partner-billing", (_req, res) => {
  const cfg = partnerBillingConfig();
  res.json({
    ready: partnerBillingReady(),
    currency: cfg.currency,
    hasCreditLine: Boolean(cfg.creditLineId),
    hasPartnerToken: Boolean(cfg.partnerToken),
    hasPartnerBusiness: Boolean(cfg.partnerBusinessId),
  });
});

router.post("/whatsapp-accounts/:id/attach-billing", async (req, res) => {
  const wa = await prisma.whatsAppAccount.findUnique({ where: { id: req.params.id } });
  if (!wa?.wabaId) return res.status(400).json({ error: "No WABA on this account" });
  const result = await applyPartnerBillingToAccount(wa);
  res.json(result);
});

router.post("/whatsapp-accounts/attach-billing-all", async (_req, res) => {
  const accounts = await prisma.whatsAppAccount.findMany({
    where: { isConnected: true, wabaId: { not: null } },
  });
  const results = [];
  for (const wa of accounts) {
    const r = await applyPartnerBillingToAccount(wa);
    results.push({ companyId: wa.companyId, wabaId: wa.wabaId, ...r });
  }
  res.json({ ok: true, count: results.length, results });
});

router.post("/whatsapp-accounts/:id/disconnect", async (req, res) => {
  const a = await prisma.whatsAppAccount.update({
    where: { id: req.params.id },
    data: { isConnected: false, status: "disconnected", accessToken: null, webhookStatus: "pending" },
  });
  res.json(a);
});

router.post("/whatsapp-accounts/:id/refresh-token", async (req, res) => {
  const a = await prisma.whatsAppAccount.findUnique({ where: { id: req.params.id } });
  if (!a) return res.status(404).json({ error: "not found" });
  if (!a.accessToken) return res.status(400).json({ error: "No token — client must reconnect" });
  try {
    const { exchangeForLongLivedToken, fetchPhoneDetails } = await import("../lib/metaOAuth.js");
    const longLived = await exchangeForLongLivedToken(a.accessToken);
    const token = longLived.access_token || a.accessToken;
    let phoneMeta = null;
    if (a.phoneNumberId) {
      phoneMeta = await fetchPhoneDetails(a.phoneNumberId, token).catch(() => null);
    }
    const updated = await prisma.whatsAppAccount.update({
      where: { id: a.id },
      data: {
        accessToken: token,
        tokenExpiresAt: longLived.expires_in
          ? new Date(Date.now() + Number(longLived.expires_in) * 1000)
          : a.tokenExpiresAt,
        qualityRating: phoneMeta?.quality_rating || a.qualityRating,
        messagingLimit: phoneMeta?.messaging_limit_tier || a.messagingLimit,
        lastSyncAt: new Date(),
        lastError: null,
        isConnected: true,
        status: "connected",
      },
    });
    res.json({ ok: true, account: updated });
  } catch (e) {
    res.status(400).json({ error: e.message || "Token refresh failed" });
  }
});

router.get("/whatsapp-accounts/:id/profile", async (req, res) => {
  const a = await prisma.whatsAppAccount.findUnique({
    where: { id: req.params.id },
    include: { company: { select: { name: true } } },
  });
  if (!a) return res.status(404).json({ error: "not found" });
  if (!a.phoneNumberId || !a.accessToken) {
    return res.status(400).json({ error: "Account has no live Meta credentials" });
  }
  try {
    const profile = await fetchBusinessProfile(a.phoneNumberId, a.accessToken);
    res.json({
      ...profile,
      displayName: a.businessName || a.verifiedName || "",
      verifiedName: a.verifiedName || "",
      phoneNumber: a.displayPhoneNumber || a.phoneNumber,
      companyName: a.company?.name || "",
      verticals: VERTICALS,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch("/whatsapp-accounts/:id/profile", async (req, res) => {
  const a = await prisma.whatsAppAccount.findUnique({ where: { id: req.params.id } });
  if (!a) return res.status(404).json({ error: "not found" });
  if (!a.phoneNumberId || !a.accessToken) {
    return res.status(400).json({ error: "Account has no live Meta credentials" });
  }
  try {
    const { displayName, about, address, description, email, website, vertical } = req.body || {};
    await updateBusinessProfile(a.phoneNumberId, a.accessToken, {
      about, address, description, email, website, vertical,
    });
    if (displayName != null && String(displayName).trim()) {
      await prisma.whatsAppAccount.update({
        where: { id: a.id },
        data: { businessName: String(displayName).trim() },
      });
    }
    const profile = await fetchBusinessProfile(a.phoneNumberId, a.accessToken).catch(() => ({}));
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/whatsapp-accounts/:id/profile/photo", profileUpload.single("file"), async (req, res) => {
  const a = await prisma.whatsAppAccount.findUnique({ where: { id: req.params.id } });
  if (!a) return res.status(404).json({ error: "not found" });
  if (!a.phoneNumberId || !a.accessToken) {
    return res.status(400).json({ error: "Account has no live Meta credentials" });
  }
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "Image file required (JPG or PNG, max 5MB)" });
    const handle = await uploadProfilePicture(
      a.accessToken,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );
    await updateBusinessProfile(a.phoneNumberId, a.accessToken, { profile_picture_handle: handle });
    const profile = await fetchBusinessProfile(a.phoneNumberId, a.accessToken).catch(() => ({}));
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------- Plans ---------- */
function serializePlan(row, cat, subscribers = 0) {
  const c = cat || PLAN_CATALOG[row.key] || PLAN_CATALOG.starter;
  return {
    key: row.key,
    name: row.name || c.name,
    amount: row.amount ?? c.amount,
    currency: row.currency || c.currency || "INR",
    inbox: row.inbox ?? c.features?.inbox !== false,
    campaign: row.campaign ?? c.features?.campaign !== false,
    chatbot: row.chatbot ?? c.features?.chatbot !== false,
    automation: row.automation ?? c.features?.automation !== false,
    api: row.api ?? Boolean(c.features?.api),
    unlimitedAgents: row.unlimitedAgents ?? Boolean(c.features?.unlimitedAgents),
    agentLimit: row.agentLimit ?? c.agentLimit ?? 3,
    contactLimit: row.contactLimit ?? c.contactLimit ?? 1000,
    messageLimit: row.messageLimit ?? c.messageLimit ?? 5000,
    active: row.active !== false,
    subscribers,
  };
}

router.get("/plans", async (_req, res) => {
  const rows = await prisma.plan.findMany();
  const byKey = Object.fromEntries(rows.map((p) => [p.key, p]));
  let counts = [];
  try {
    counts = await prisma.company.groupBy({ by: ["plan"], _count: { id: true } });
  } catch {}
  const countMap = Object.fromEntries(counts.map((c) => [c.plan, c._count.id]));
  const keys = ["starter", "growth", "professional", "enterprise"];
  res.json(keys.map((key) => serializePlan(byKey[key] || { key, active: true, ...PLAN_CATALOG[key], ...PLAN_CATALOG[key]?.features }, PLAN_CATALOG[key], countMap[key] || 0)));
});

router.patch("/plans/:key", async (req, res) => {
  const key = normalizePlan(req.params.key);
  if (!["starter", "growth", "professional", "enterprise"].includes(key)) {
    return res.status(400).json({ error: "Only sellable plans can be updated" });
  }
  const body = req.body || {};
  const update = {};
  if (body.name != null) update.name = String(body.name);
  if (body.amount != null) update.amount = Number(body.amount);
  if (typeof body.inbox === "boolean") update.inbox = body.inbox;
  if (typeof body.campaign === "boolean") update.campaign = body.campaign;
  if (typeof body.chatbot === "boolean") update.chatbot = body.chatbot;
  if (typeof body.automation === "boolean") update.automation = body.automation;
  if (typeof body.api === "boolean") update.api = body.api;
  if (typeof body.unlimitedAgents === "boolean") update.unlimitedAgents = body.unlimitedAgents;
  if (body.agentLimit != null) update.agentLimit = Number(body.agentLimit);
  if (body.contactLimit != null) update.contactLimit = Number(body.contactLimit);
  if (body.messageLimit != null) update.messageLimit = Number(body.messageLimit);
  if (typeof body.active === "boolean") update.active = body.active;
  const cat = PLAN_CATALOG[key] || PLAN_CATALOG.starter;
  const plan = await prisma.plan.upsert({
    where: { key },
    update,
    create: {
      key,
      name: update.name || cat.name || key,
      amount: update.amount ?? cat.amount ?? 0,
      inbox: update.inbox ?? cat.features?.inbox !== false,
      campaign: update.campaign ?? cat.features?.campaign !== false,
      chatbot: update.chatbot ?? cat.features?.chatbot !== false,
      automation: update.automation ?? cat.features?.automation !== false,
      api: update.api ?? Boolean(cat.features?.api),
      unlimitedAgents: update.unlimitedAgents ?? Boolean(cat.features?.unlimitedAgents),
      agentLimit: update.agentLimit ?? cat.agentLimit ?? 3,
      contactLimit: update.contactLimit ?? cat.contactLimit ?? 1000,
      messageLimit: update.messageLimit ?? cat.messageLimit ?? 5000,
      active: update.active !== false,
    },
  });
  if (typeof body.active === "boolean") {
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: body.active ? "plan_activate" : "plan_deactivate",
        entity: "Plan",
        entityId: plan.id,
        meta: { key, active: body.active },
      },
    }).catch(() => {});
  }
  const subscribers = await prisma.company.count({ where: { plan: key } }).catch(() => 0);
  res.json(serializePlan(plan, cat, subscribers));
});

/* ---------- Payments ---------- */
router.get("/payments", async (req, res) => {
  const status = req.query.status;
  const where = status ? { status: String(status) } : {};
  const payments = await prisma.payment.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { company: { select: { name: true } }, user: { select: { name: true, email: true } } },
  });
  res.json(
    payments.map((p) => ({
      id: p.id,
      companyName: p.company?.name,
      userName: p.user?.name,
      email: p.user?.email,
      plan: p.plan,
      type: p.type,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      creditsAdded: p.creditsAdded,
      invoiceNo: p.invoiceNo,
      razorpayOrderId: p.razorpayOrderId,
      razorpayPaymentId: p.razorpayPaymentId,
      refundId: p.refundId,
      transactionId: p.razorpayPaymentId || p.invoiceNo || p.id,
      couponCode: p.couponCode,
      paidAt: p.paidAt ? p.paidAt.getTime() : null,
      createdAt: p.createdAt.getTime(),
    }))
  );
});

router.post("/payments/:id/refund", async (req, res) => {
  const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!payment) return res.status(404).json({ error: "not found" });
  if (payment.status !== "paid") return res.status(400).json({ error: "Only paid payments can be refunded" });
  let refundId = `manual_${Date.now()}`;
  // Cashfree refund — mark as refunded manually (Cashfree refund API can be added later)
  if (CASHFREE_ENABLED && payment.razorpayPaymentId) {
    console.log("[refund] Cashfree payment id:", payment.razorpayPaymentId, "— marked refunded manually");
  }
  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: "refunded", refundId },
  });
  await prisma.auditLog.create({
    data: {
      companyId: payment.companyId,
      userId: req.user.id,
      action: "payment_refund",
      entity: "Payment",
      entityId: payment.id,
      meta: { refundId, transactionId: payment.razorpayPaymentId || payment.invoiceNo || payment.id, amount: payment.amount },
    },
  }).catch(() => {});
  res.json({ ...updated, transactionId: payment.razorpayPaymentId || payment.invoiceNo || payment.id });
});

/* ---------- Revenue ---------- */
router.get("/revenue", async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;
  const paid = await prisma.payment.findMany({ where: { status: "paid" } });
  const refunded = await prisma.payment.findMany({ where: { status: "refunded" } });
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay()); startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const inRange = (p, start, end) => {
    const d = p.paidAt || p.createdAt;
    if (start && d < start) return false;
    if (end) {
      const e = new Date(end);
      e.setHours(23, 59, 59, 999);
      if (d > e) return false;
    }
    return true;
  };
  const sum = (list, start, end) => list.filter((p) => inRange(p, start, end)).reduce((s, p) => s + p.amount, 0);
  const mrr = sum(paid, startOfMonth);
  const rangePayments = paid.filter((p) => inRange(p, from, to)).map((p) => ({
    id: p.id,
    transactionId: p.razorpayPaymentId || p.invoiceNo || p.id,
    amount: p.amount,
    type: p.type,
    plan: p.plan,
    paidAt: (p.paidAt || p.createdAt).getTime(),
    companyId: p.companyId,
  }));
  res.json({
    daily: sum(paid, startOfDay),
    weekly: sum(paid, startOfWeek),
    monthly: sum(paid, startOfMonth),
    yearly: sum(paid, startOfYear),
    mrr,
    arr: mrr * 12,
    total: paid.reduce((s, p) => s + p.amount, 0),
    range: {
      from: from ? from.toISOString().slice(0, 10) : null,
      to: to ? to.toISOString().slice(0, 10) : null,
      paid: sum(paid, from, to),
      refunded: sum(refunded, from, to),
      count: rangePayments.length,
      payments: rangePayments,
    },
  });
});

/* ---------- Coupons ---------- */
router.get("/coupons", async (_req, res) => {
  const coupons = await prisma.coupon.findMany({ orderBy: { createdAt: "desc" } });
  res.json(coupons);
});

router.post("/coupons", async (req, res) => {
  const { code, description = "", discountPct = 0, freeDays = 0, maxRedemptions } = req.body || {};
  if (!code) return res.status(400).json({ error: "code required" });
  const coupon = await prisma.coupon.create({
    data: {
      code: String(code).toUpperCase().trim(),
      description,
      discountPct: Number(discountPct) || 0,
      freeDays: Number(freeDays) || 0,
      maxRedemptions: maxRedemptions != null ? Number(maxRedemptions) : null,
    },
  });
  res.status(201).json(coupon);
});

router.patch("/coupons/:id", async (req, res) => {
  const body = req.body || {};
  const data = {};
  if (body.code != null) data.code = String(body.code).toUpperCase().trim();
  if (body.description != null) data.description = String(body.description);
  if (body.discountPct != null) data.discountPct = Number(body.discountPct) || 0;
  if (body.freeDays != null) data.freeDays = Number(body.freeDays) || 0;
  if (body.maxRedemptions !== undefined) data.maxRedemptions = body.maxRedemptions === null || body.maxRedemptions === "" ? null : Number(body.maxRedemptions);
  if (body.active != null) data.active = Boolean(body.active);
  const coupon = await prisma.coupon.update({ where: { id: req.params.id }, data });
  res.json(coupon);
});

router.delete("/coupons/:id", async (req, res) => {
  await prisma.coupon.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

/* ---------- Usage / analytics ---------- */
router.get("/usage", async (_req, res) => {
  const now = new Date();
  const usages = await prisma.usage.findMany({
    where: { month: now.getMonth() + 1, year: now.getFullYear() },
    include: { company: { select: { name: true } } },
  });
  const msgOut = await prisma.message.groupBy({
    by: ["companyId"],
    where: { direction: "out" },
    _count: true,
  }).catch(() => []);
  res.json({
    monthly: usages.map((u) => ({
      companyId: u.companyId,
      companyName: u.company?.name,
      messagesSent: u.messagesSent,
      messagesRecv: u.messagesRecv,
      campaignsCount: u.campaignsCount,
      apiCalls: u.apiCalls,
    })),
    allTimeSent: msgOut,
  });
});

router.get("/analytics", async (_req, res) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const [sent, received, delivered, read, failed] = await Promise.all([
    prisma.message.count({ where: { direction: "out", at: { gte: start } } }),
    prisma.message.count({ where: { direction: "in", at: { gte: start } } }),
    prisma.message.count({ where: { direction: "out", status: "delivered", at: { gte: start } } }),
    prisma.message.count({ where: { direction: "out", status: "read", at: { gte: start } } }),
    prisma.message.count({ where: { direction: "out", status: "failed", at: { gte: start } } }),
  ]);
  const out = sent || 1;
  res.json({
    messagesSentToday: sent,
    messagesReceived: received,
    deliveryPct: Math.round((delivered / out) * 100),
    readPct: Math.round((read / out) * 100),
    failedPct: Math.round((failed / out) * 100),
  });
});

/* ---------- System monitoring ---------- */
function platformMessagingPhone() {
  const raw = String(
    process.env.PLATFORM_MESSAGING_PHONE ||
    process.env.ADMIN_MESSAGING_PHONE ||
    "917631100654"
  ).replace(/\D/g, "");
  if (!raw) return null;
  if (raw.startsWith("91") && raw.length === 12) {
    return `+91 ${raw.slice(2, 7)} ${raw.slice(7)}`;
  }
  return raw.startsWith("+") ? raw : `+${raw}`;
}

router.get("/system", async (_req, res) => {
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {}
  const platformPhone = platformMessagingPhone();
  res.json({
    webhook: { ok: true, label: "Webhook endpoint" },
    meta: { ok: WA_LIVE, label: "Meta WhatsApp API", detail: WA_LIVE ? "live" : "demo / not configured" },
    platformPhone: {
      ok: Boolean(platformPhone),
      label: "Platform messaging number",
      detail: platformPhone || "Set PLATFORM_MESSAGING_PHONE in server .env",
    },
    cashfree: { ok: CASHFREE_ENABLED, label: "Cashfree", detail: CASHFREE_ENABLED ? "configured" : "missing keys" },
    database: { ok: dbOk, label: "PostgreSQL" },
    redis: { ok: false, label: "Redis", detail: "optional — not configured" },
    queue: { ok: true, label: "Campaign/Drip queue", detail: "in-process scheduler" },
    cron: { ok: true, label: "Scheduler", detail: "30s interval" },
    disk: { ok: true, label: "Disk", detail: "uploads/" },
    memory: { ok: true, label: "Memory", detail: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB heap` },
    cpu: { ok: true, label: "CPU", detail: `${(process.uptime() / 3600).toFixed(1)}h uptime` },
  });
});

/* ---------- Platform WhatsApp inbox (76311 00654) ---------- */
router.get("/inbox/unread", async (_req, res) => {
  const companyId = await getPlatformCompanyId();
  if (!companyId) return res.json({ unread: 0 });
  const unread = await prisma.message.count({
    where: { companyId, direction: "in", status: { not: "read" } },
  });
  res.json({ unread });
});

router.get("/inbox/conversations", async (_req, res) => {
  const companyId = await getPlatformCompanyId();
  if (!companyId) {
    return res.json({ conversations: [], platformPhone: platformPhoneDisplay() });
  }
  const conversations = await buildPlatformConversations(companyId);
  res.json({ conversations, platformPhone: platformPhoneDisplay() });
});

router.get("/inbox/conversations/:contactId/messages", async (req, res) => {
  const companyId = await getPlatformCompanyId();
  if (!companyId) return res.sendStatus(404);
  const contact = await prisma.contact.findFirst({
    where: { id: req.params.contactId, companyId },
    include: { assignedAgent: true },
  });
  if (!contact) return res.sendStatus(404);
  await prisma.message.updateMany({
    where: { contactId: contact.id, direction: "in", status: { not: "read" } },
    data: { status: "read" },
  });
  const messages = await prisma.message.findMany({
    where: { contactId: contact.id },
    orderBy: { at: "asc" },
  });
  const clientContact = await prisma.contact.findFirst({
    where: { phone: contact.phone, companyId: { not: companyId } },
    include: { company: { select: { id: true, name: true, plan: true, email: true } } },
  });
  const lastInbound = [...messages].reverse().find((m) => m.direction === "in");
  res.json({
    contact: {
      ...contact,
      createdAt: contact.createdAt.getTime(),
      lastInboundAt: lastInbound ? lastInbound.at.getTime() : null,
      sessionOpen: lastInbound ? Date.now() - lastInbound.at.getTime() < 24 * 60 * 60 * 1000 : false,
      assignedAgent: contact.assignedAgent
        ? { id: contact.assignedAgent.id, name: contact.assignedAgent.name, color: contact.assignedAgent.color }
        : null,
      clientCompany: clientContact?.company?.name || null,
      clientPlan: clientContact?.company?.plan || null,
      clientEmail: clientContact?.company?.email || null,
    },
    messages: messages.map(toMessage),
    platformPhone: platformPhoneDisplay(),
  });
});

router.post("/inbox/conversations/:contactId/messages", async (req, res) => {
  const companyId = await getPlatformCompanyId();
  if (!companyId) return res.status(503).json({ error: "Platform inbox not configured" });
  const contact = await prisma.contact.findFirst({
    where: { id: req.params.contactId, companyId },
  });
  if (!contact) return res.sendStatus(404);
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  const creds = platformWaCreds();
  if (!creds?.phoneNumberId || !creds?.accessToken) {
    return res.status(503).json({ error: "Platform WhatsApp not configured in server .env" });
  }
  let waId = null;
  try {
    const result = await sendText(contact.phone, String(text), creds);
    waId = result.messages?.[0]?.id || null;
  } catch (e) {
    return res.status(502).json({ error: e.message || "Send failed" });
  }
  const msg = await prisma.message.create({
    data: {
      companyId,
      contactId: contact.id,
      waId,
      direction: "out",
      type: "text",
      text: String(text),
      status: "sent",
      senderName: req.user?.name || "Nexwapi",
      senderUserId: req.user?.id || null,
    },
  });
  res.status(201).json(toMessage(msg));
});

router.get("/inbox/agents", async (_req, res) => {
  const companyId = await getPlatformCompanyId();
  if (!companyId) return res.json([]);
  const agents = await listPlatformAgents(companyId);
  res.json(agents);
});

router.patch("/inbox/conversations/:contactId/status", async (req, res) => {
  const { status } = req.body || {};
  if (!["open", "pending", "resolved"].includes(status)) {
    return res.status(400).json({ error: "invalid status" });
  }
  const { contact } = await platformContactOr404(req.params.contactId, res);
  if (!contact) return;
  const updated = await prisma.contact.update({
    where: { id: contact.id },
    data: { chatStatus: status },
  });
  res.json({ chatStatus: updated.chatStatus });
});

router.patch("/inbox/conversations/:contactId/assign", async (req, res) => {
  const { agentId } = req.body || {};
  const { companyId, contact } = await platformContactOr404(req.params.contactId, res);
  if (!contact) return;
  if (agentId) {
    const agent = await prisma.agent.findFirst({ where: { id: agentId, companyId } });
    if (!agent) return res.status(400).json({ error: "Invalid agent" });
  }
  const updated = await prisma.contact.update({
    where: { id: contact.id },
    data: { assignedAgentId: agentId || null },
    include: { assignedAgent: true },
  });
  res.json({
    assignedAgent: updated.assignedAgent
      ? { id: updated.assignedAgent.id, name: updated.assignedAgent.name, color: updated.assignedAgent.color }
      : null,
  });
});

router.post("/inbox/conversations/:contactId/media", inboxUpload.single("file"), async (req, res) => {
  const { companyId, contact } = await platformContactOr404(req.params.contactId, res);
  if (!contact) return;
  if (!req.file) return res.status(400).json({ error: "file required" });
  const creds = platformWaCreds();
  if (!creds?.phoneNumberId || !creds?.accessToken) {
    return res.status(503).json({ error: "Platform WhatsApp not configured in server .env" });
  }

  const { originalname, mimetype, filename, path: tmpPath } = req.file;
  const storedName = filename + (path.extname(originalname) || "");
  fs.renameSync(tmpPath, path.join(UPLOAD_DIR, storedName));
  const base = String(process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  const publicUrl = `${base}/uploads/${storedName}`;
  const waType = waMediaType(mimetype);
  const caption = req.body?.caption || "";

  let waId = null;
  try {
    const mediaId = await uploadMedia(fs.readFileSync(path.join(UPLOAD_DIR, storedName)), mimetype, originalname, creds);
    if (mediaId) {
      const r = await sendMediaById(contact.phone, waType, mediaId, { filename: originalname, caption }, creds);
      waId = r.messages?.[0]?.id || null;
    }
  } catch (e) {
    return res.status(502).json({ error: e.message || "Upload failed" });
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
      senderName: req.user?.name || "Nexwapi",
      senderUserId: req.user?.id || null,
    },
  });
  res.status(201).json(toMessage(msg));
});

router.get("/inbox/conversations/:contactId/notes", async (req, res) => {
  const { contact } = await platformContactOr404(req.params.contactId, res);
  if (!contact) return;
  const notes = await prisma.note.findMany({
    where: { contactId: contact.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(notes.map((n) => ({ ...n, createdAt: n.createdAt.getTime() })));
});

router.post("/inbox/conversations/:contactId/notes", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  const { contact } = await platformContactOr404(req.params.contactId, res);
  if (!contact) return;
  const note = await prisma.note.create({
    data: { contactId: contact.id, text: String(text), author: req.user?.name || "Admin" },
  });
  res.status(201).json({ ...note, createdAt: note.createdAt.getTime() });
});

router.delete("/inbox/notes/:id", async (req, res) => {
  const companyId = await getPlatformCompanyId();
  if (!companyId) return res.sendStatus(404);
  const note = await prisma.note.findUnique({
    where: { id: req.params.id },
    include: { contact: { select: { companyId: true } } },
  });
  if (!note || note.contact.companyId !== companyId) return res.sendStatus(404);
  await prisma.note.delete({ where: { id: note.id } });
  res.sendStatus(204);
});

router.delete("/inbox/conversations/:contactId/messages/:messageId", async (req, res) => {
  const { companyId, contact } = await platformContactOr404(req.params.contactId, res);
  if (!contact) return;
  const messageId = String(req.params.messageId || "");
  const scope = String(req.body?.scope || req.query.scope || "me").toLowerCase();
  const msg = await prisma.message.findFirst({
    where: {
      companyId,
      contactId: contact.id,
      OR: [{ id: messageId }, { waId: messageId }],
    },
  });
  if (!msg) return res.sendStatus(404);
  if (scope === "everyone") {
    if (msg.direction !== "out") {
      return res.status(400).json({ error: "Delete for everyone only applies to messages you sent." });
    }
    const updated = await prisma.message.update({
      where: { id: msg.id },
      data: {
        type: "deleted",
        text: "This message was deleted",
        mediaUrl: null,
        filename: null,
        status: "deleted",
        error: null,
      },
    });
    return res.json({
      ok: true,
      scope: "everyone",
      note: "Removed in Nexwapi inbox. WhatsApp Cloud API cannot delete it from the customer's phone.",
      message: toMessage(updated),
    });
  }
  await prisma.message.delete({ where: { id: msg.id } });
  res.json({ ok: true, scope: "me", deletedId: msg.id });
});

router.get("/inbox/calling/events", async (req, res) => {
  const companyId = await getPlatformCompanyId();
  if (!companyId) return res.json({ events: [], after: 0 });
  const after = Number(req.query.after || 0) || 0;
  const wait = Math.min(10000, Math.max(0, Number(req.query.wait || 0) || 0));
  const { takeCallSignals } = await import("../lib/callBus.js");
  const events = await takeCallSignals(companyId, after, wait, req);
  const last = events.length ? events[events.length - 1].id : after;
  res.json({ events, after: last });
});

router.get("/inbox/calling/status", async (_req, res) => {
  const companyId = await getPlatformCompanyId();
  if (!companyId) return res.status(503).json({ error: "Platform inbox not configured" });
  const { callingStatusForAccount, waAccountForCompany } = await import("../lib/waCalling.js");
  const wa = (await waAccountForCompany(companyId)) || {
    isConnected: Boolean(platformWaCreds()),
    phoneNumberId: platformWaCreds()?.phoneNumberId,
    accessToken: platformWaCreds()?.accessToken,
    displayPhoneNumber: platformPhoneDisplay(),
    phoneNumber: process.env.PLATFORM_MESSAGING_PHONE,
    messagingLimit: "TIER_10K",
  };
  const status = await callingStatusForAccount({
    ...wa,
    isConnected: Boolean(wa.phoneNumberId && wa.accessToken),
  });
  res.json(status);
});

router.post("/inbox/calling/enable", async (_req, res) => {
  const creds = platformWaCreds();
  if (!creds?.phoneNumberId || !creds?.accessToken) {
    return res.status(503).json({ error: "Platform WhatsApp not configured in server .env" });
  }
  const { setCallingEnabled, ensureCallsWebhookSubscription, callingStatusForAccount } = await import("../lib/waCalling.js");
  await ensureCallsWebhookSubscription().catch(() => {});
  await setCallingEnabled(creds.phoneNumberId, creds.accessToken, true);
  const after = await callingStatusForAccount({
    isConnected: true,
    phoneNumberId: creds.phoneNumberId,
    accessToken: creds.accessToken,
    messagingLimit: "TIER_10K",
  });
  res.json(after);
});

router.post("/inbox/calling/start", async (req, res) => {
  const { companyId, contact } = await platformContactOr404(req.body?.contactId, res);
  if (!contact) return;
  const { sdp, sdpType } = req.body || {};
  if (!sdp) return res.status(400).json({ error: "Missing WebRTC offer." });
  const creds = platformWaCreds();
  if (!creds?.phoneNumberId || !creds?.accessToken) {
    return res.status(503).json({ error: "Platform WhatsApp not configured" });
  }
  const { graphCall, logCallMessage } = await import("../lib/waCalling.js");
  const to = String(contact.phone).replace(/\D/g, "");
  const data = await graphCall(creds.phoneNumberId, creds.accessToken, {
    to,
    action: "connect",
    session: { sdp_type: sdpType || "offer", sdp },
  });
  const callId = data?.calls?.[0]?.id || data?.id || null;
  await logCallMessage({
    companyId,
    contactId: contact.id,
    callId,
    event: "outbound",
    text: `Calling +${to}`,
    direction: "out",
  });
  res.json({ ok: true, callId, contactId: contact.id, phone: to, meta: data });
});

router.post("/inbox/calling/action", async (req, res) => {
  const { callId, action, sdp, sdpType } = req.body || {};
  if (!callId || !action) return res.status(400).json({ error: "callId and action required" });
  const creds = platformWaCreds();
  if (!creds?.phoneNumberId || !creds?.accessToken) {
    return res.status(503).json({ error: "Platform WhatsApp not configured" });
  }
  const { graphCall } = await import("../lib/waCalling.js");
  const body = { call_id: callId, action: String(action) };
  if (sdp) body.session = { sdp_type: sdpType || "answer", sdp };
  const data = await graphCall(creds.phoneNumberId, creds.accessToken, body);
  res.json({ ok: true, meta: data });
});

/* ---------- Tickets / logs ---------- */
router.get("/tickets", async (_req, res) => {
  const tickets = await prisma.ticket.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { company: true, user: true },
  });
  res.json(tickets.map((t) => ({
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
    name: t.user?.name || t.company?.name,
    email: t.user?.email || t.company?.email,
    client: {
      name: t.user?.name || t.company?.name || "—",
      email: t.user?.email || t.company?.email || "—",
      company: t.company?.name || "—",
      plan: t.company?.plan || null,
      phone: t.company?.phone || null,
    },
  })));
});

router.patch("/tickets/:id", async (req, res) => {
  const data = {};
  if (["open", "pending", "closed"].includes(req.body?.status)) data.status = req.body.status;
  if (["low", "normal", "high", "urgent"].includes(req.body?.priority)) data.priority = req.body.priority;
  if (req.body?.adminReply != null) data.adminReply = String(req.body.adminReply).slice(0, 5000);
  const ticket = await prisma.ticket.update({ where: { id: req.params.id }, data });
  if (data.adminReply) {
    notify({
      audience: "client",
      companyId: ticket.companyId,
      title: "Support replied",
      body: ticket.subject,
      href: "/dashboard/support",
    }).catch(() => {});
  }
  res.json(ticket);
});

router.post("/tickets", async (req, res) => {
  const companyId = String(req.body?.companyId || "").trim();
  const subject = String(req.body?.subject || "").trim();
  const body = String(req.body?.body || req.body?.message || "").trim();
  const priority = ["low", "normal", "high", "urgent"].includes(String(req.body?.priority || "").toLowerCase())
    ? String(req.body.priority).toLowerCase()
    : "normal";
  if (!companyId) return res.status(400).json({ error: "companyId required" });
  if (!subject) return res.status(400).json({ error: "Subject is required" });
  if (!body) return res.status(400).json({ error: "Message is required" });
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return res.status(404).json({ error: "Client not found" });
  const ticket = await prisma.ticket.create({
    data: {
      companyId,
      userId: req.user.id,
      subject: subject.slice(0, 200),
      body: body.slice(0, 5000),
      priority,
      status: "open",
      origin: "admin",
    },
  });
  await prisma.auditLog.create({
    data: { companyId, userId: req.user.id, action: "ticket_create", entity: "Ticket", entityId: ticket.id, meta: { subject } },
  }).catch(() => {});
  res.status(201).json(ticket);
});

router.get("/logs", async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.min(500, Number(req.query.limit) || 200),
      include: { company: { select: { name: true, email: true } } },
    });
    const userIds = [...new Set(logs.map((l) => l.userId).filter(Boolean))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
      : [];
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));
    res.json(logs.map((l) => ({
      id: l.id,
      action: l.action,
      entity: l.entity,
      entityId: l.entityId,
      meta: l.meta,
      ip: l.ip,
      companyId: l.companyId,
      companyName: l.company?.name || "—",
      userId: l.userId,
      userName: byId[l.userId]?.name || "—",
      userEmail: byId[l.userId]?.email || "—",
      createdAt: l.createdAt.getTime(),
    })));
  } catch (e) {
    console.error("[logs]", e);
    res.status(500).json({ error: e.message || "Could not load logs" });
  }
});

router.post("/templates/sync", async (_req, res) => {
  const { syncAllConnectedTemplateStatuses } = await import("../lib/templateSync.js");
  const result = await syncAllConnectedTemplateStatuses();
  res.json({ ok: true, ...result });
});

router.get("/templates", async (_req, res) => {
  try {
    const { syncAllConnectedTemplateStatuses } = await import("../lib/templateSync.js");
    await syncAllConnectedTemplateStatuses();
  } catch (e) {
    console.warn("[admin templates] sync", e?.message || e);
  }
  const templates = await prisma.template.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { company: { select: { name: true, email: true, phone: true } } },
  });
  res.json(templates.map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    language: t.language,
    status: t.status,
    body: t.body,
    format: t.format,
    companyId: t.companyId,
    companyName: t.company?.name || "—",
    companyEmail: t.company?.email || "—",
    companyPhone: t.company?.phone || "",
    createdAt: t.createdAt.getTime(),
  })));
});

router.patch("/templates/:id", async (req, res) => {
  const status = String(req.body?.status || "").toLowerCase();
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "status must be approved, rejected, or pending" });
  }
  const template = await prisma.template.update({
    where: { id: req.params.id },
    data: { status },
  });
  // Notify company owner about approval/rejection
  if (status === "approved" || status === "rejected") {
    const msg = status === "approved"
      ? `✅ Your template "${template.name}" has been approved! You can now use it in campaigns.`
      : `❌ Your template "${template.name}" was rejected.${req.body?.reason ? " Reason: " + req.body.reason : ""} Please review and resubmit.`;
    notify({
      audience: "client",
      companyId: template.companyId,
      title: `Template ${status}`,
      body: msg,
      href: "/dashboard/templates",
    }).catch(() => {});
  }
  await prisma.auditLog.create({
    data: {
      companyId: template.companyId,
      userId: req.user.id,
      action: "template_" + status,
      entity: "Template",
      entityId: template.id,
      meta: { name: template.name, status, reason: req.body?.reason || null },
    },
  }).catch(() => {});
  res.json({ ...template, createdAt: template.createdAt.getTime() });
});

router.delete("/templates/:id", async (req, res) => {
  const existing = await prisma.template.findFirst({ where: { id: req.params.id } });
  if (!existing) return res.sendStatus(404);
  await prisma.template.delete({ where: { id: existing.id } });
  await prisma.auditLog.create({
    data: {
      companyId: existing.companyId,
      userId: req.user.id,
      action: "template_delete",
      entity: "Template",
      entityId: existing.id,
      meta: { name: existing.name },
    },
  }).catch(() => {});
  res.json({ ok: true });
});

/* ---- Admin: Segments overview ---- */
router.get("/segments", async (_req, res) => {
  const segments = await prisma.segment.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { company: { select: { name: true, email: true } } },
  });
  const withCounts = await Promise.all(
    segments.map(async (s) => {
      const contactWhere = buildSegmentContactWhere(s, s.companyId);
      const count = await prisma.contact.count({ where: contactWhere });
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        companyId: s.companyId,
        companyName: s.company?.name || "—",
        companyEmail: s.company?.email || "—",
        tags: s.tags,
        filters: s.filters,
        whatsappOnly: s.whatsappOnly,
        count,
        createdAt: s.createdAt.getTime(),
        updatedAt: s.updatedAt?.getTime?.() || s.createdAt.getTime(),
      };
    })
  );
  res.json(withCounts);
});

router.delete("/segments/:id", async (req, res) => {
  try {
    await prisma.segment.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.sendStatus(404);
  }
});

router.get("/sales-leads", async (_req, res) => {
  const leads = await prisma.salesLead.findMany({ orderBy: { createdAt: "desc" }, take: 300 });
  res.json(leads.map((l) => ({ ...l, createdAt: l.createdAt.getTime(), updatedAt: l.updatedAt.getTime() })));
});

router.patch("/sales-leads/:id", async (req, res) => {
  const data = {};
  if (req.body?.status) data.status = String(req.body.status);
  if (req.body?.note != null) data.note = String(req.body.note);
  const lead = await prisma.salesLead.update({ where: { id: req.params.id }, data });
  res.json({ ...lead, createdAt: lead.createdAt.getTime(), updatedAt: lead.updatedAt.getTime() });
});

router.delete("/sales-leads/:id", async (req, res) => {
  await prisma.salesLead.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

async function requirePlatformWa() {
  const creds = platformWaCreds();
  if (!creds) {
    const err = new Error("Platform WhatsApp is not configured in backend .env (PHONE_NUMBER_ID + ACCESS_TOKEN).");
    err.status = 400;
    throw err;
  }
  return creds;
}

router.get("/platform-profile", async (_req, res) => {
  try {
    const creds = await requirePlatformWa();
    const profile = await fetchBusinessProfile(creds.phoneNumberId, creds.accessToken);
    const wa = await prisma.whatsAppAccount.findFirst({
      where: { wabaId: process.env.WHATSAPP_WABA_ID || undefined },
      orderBy: { updatedAt: "desc" },
    }).catch(() => null);
    res.json({
      ...profile,
      displayName: profile.about || "Nexwapi",
      verifiedName: wa?.verifiedName || "",
      phoneNumber: wa?.displayPhoneNumber || platformMessagingPhone() || "",
      platformMessagingPhone: platformMessagingPhone(),
      verticals: VERTICALS,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.patch("/platform-profile", async (req, res) => {
  try {
    const creds = await requirePlatformWa();
    const { about, address, description, email, website, vertical } = req.body || {};
    await updateBusinessProfile(creds.phoneNumberId, creds.accessToken, {
      about, address, description, email, website, vertical,
    });
    const profile = await fetchBusinessProfile(creds.phoneNumberId, creds.accessToken).catch(() => ({}));
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post("/platform-profile/photo", profileUpload.single("file"), async (req, res) => {
  try {
    const creds = await requirePlatformWa();
    if (!req.file?.buffer) return res.status(400).json({ error: "Image file required (JPG or PNG, max 5MB)" });
    const handle = await uploadProfilePicture(
      creds.accessToken,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );
    await updateBusinessProfile(creds.phoneNumberId, creds.accessToken, { profile_picture_handle: handle });
    const profile = await fetchBusinessProfile(creds.phoneNumberId, creds.accessToken).catch(() => ({}));
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

const USER_ROLES = ["SUPER_ADMIN", "PARTNER", "OWNER", "ADMIN", "AGENT", "MEMBER"];

function serializeManagedUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone || "",
    role: u.role,
    isActive: u.isActive !== false,
    companyId: u.companyId,
    companyName: u.company?.name || null,
    permissions: normalizePermissions(u.permissions),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.getTime() : null,
    createdAt: u.createdAt.getTime(),
  };
}

router.get("/users/permissions", (_req, res) => {
  res.json({ permissions: PERMISSIONS });
});

router.get("/users", async (req, res) => {
  const { role, status, search } = req.query;
  const where = {
    ...(USER_ROLES.includes(String(role)) ? { role: String(role) } : {}),
    ...(status === "active" ? { isActive: true } : status === "inactive" ? { isActive: false } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: String(search), mode: "insensitive" } },
            { email: { contains: String(search), mode: "insensitive" } },
            { phone: { contains: String(search), mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [users, total, superAdmins, owners, admins, agents, inactive, platform] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 300,
      include: { company: { select: { name: true } } },
    }),
    prisma.user.count(),
    prisma.user.count({ where: { role: "SUPER_ADMIN" } }),
    prisma.user.count({ where: { role: "OWNER" } }),
    prisma.user.count({ where: { role: "ADMIN" } }),
    prisma.user.count({ where: { role: "AGENT" } }),
    prisma.user.count({ where: { isActive: false } }),
    prisma.user.count({ where: { role: { in: ["SUPER_ADMIN", "ADMIN"] }, companyId: null } }),
  ]);
  res.json({
    users: users.map(serializeManagedUser),
    stats: { total, superAdmins, owners, admins, agents, inactive, platform },
  });
});

router.post("/users", async (req, res) => {
  if (req.user.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Only Super Admin can create staff" });
  }
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").toLowerCase().trim();
  const password = String(req.body?.password || "");
  const phone = String(req.body?.phone || "").trim();
  let role = String(req.body?.role || "ADMIN");
  if (!["SUPER_ADMIN", "ADMIN"].includes(role)) role = "ADMIN";
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "An account with this email already exists" });
  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone: phone || null,
      password: await hashPassword(password),
      role,
      companyId: null,
      isActive: true,
      permissions: role === "SUPER_ADMIN" ? [] : normalizePermissions(req.body?.permissions),
    },
    include: { company: { select: { name: true } } },
  });
  await prisma.auditLog.create({
    data: { userId: req.user.id, action: "user_create", entity: "User", entityId: user.id, meta: { email, role } },
  }).catch(() => {});
  res.status(201).json(serializeManagedUser(user));
});

router.patch("/users/:id/role", async (req, res) => {
  if (req.user.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Only Super Admin can change roles" });
  }
  const role = String(req.body?.role || "");
  if (role === "PARTNER") return res.status(400).json({ error: "Partner logins are created on the Partners page" });
  if (!USER_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot change your own role" });
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.role === "PARTNER") {
    return res.status(400).json({ error: "Partner accounts cannot be promoted to Super Admin. Manage them on Partners." });
  }
  const data = { role };
  if (role === "SUPER_ADMIN") data.companyId = null;
  if ((role === "OWNER" || role === "AGENT" || role === "MEMBER") && !target.companyId) {
    return res.status(400).json({ error: "This role needs a client workspace. Create them from Clients instead." });
  }
  const updated = await prisma.user.update({
    where: { id: target.id },
    data,
    include: { company: { select: { name: true } } },
  });
  await prisma.auditLog.create({
    data: { userId: req.user.id, action: "user_role", entity: "User", entityId: updated.id, meta: { role } },
  }).catch(() => {});
  res.json(serializeManagedUser(updated));
});

router.patch("/users/:id/permissions", async (req, res) => {
  if (req.user.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Only Super Admin can set access" });
  }
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.role === "SUPER_ADMIN") {
    return res.status(400).json({ error: "Super Admin already has full access" });
  }
  const updated = await prisma.user.update({
    where: { id: target.id },
    data: { permissions: normalizePermissions(req.body?.permissions) },
    include: { company: { select: { name: true } } },
  });
  res.json(serializeManagedUser(updated));
});

router.patch("/users/:id/active", async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "You cannot deactivate your own account" });
  }
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.role === "SUPER_ADMIN" && req.user.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Only Super Admin can manage Super Admin accounts" });
  }
  const updated = await prisma.user.update({
    where: { id: target.id },
    data: { isActive: Boolean(req.body?.isActive) },
    include: { company: { select: { name: true } } },
  });
  res.json(serializeManagedUser(updated));
});

router.delete("/users/:id", async (req, res) => {
  if (req.user.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Only Super Admin can delete users" });
  }
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot delete your own account" });
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "User not found" });
  await prisma.user.delete({ where: { id: target.id } });
  await prisma.auditLog.create({
    data: { userId: req.user.id, action: "user_delete", entity: "User", entityId: target.id, meta: { email: target.email } },
  }).catch(() => {});
  res.json({ ok: true });
});

/* ─────────────────────────── Admin: Campaigns ─────────────────────────── */

function serializeAdminCampaign(c) {
  return {
    ...c,
    createdAt: c.createdAt instanceof Date ? c.createdAt.getTime() : c.createdAt,
    scheduledAt: c.scheduledAt instanceof Date ? c.scheduledAt.getTime() : (c.scheduledAt || null),
    liveAt: c.liveAt instanceof Date ? c.liveAt.getTime() : (c.liveAt || null),
    companyName: c.company?.name || "—",
    companyEmail: c.company?.email || "—",
  };
}

// GET /admin/campaigns — list all campaigns across all tenants
router.get("/campaigns", async (req, res) => {
  const { status, companyId, q, limit = "50", offset = "0" } = req.query;
  const where = {};
  if (status) where.status = status;
  if (companyId) where.companyId = companyId;
  if (q) where.name = { contains: q, mode: "insensitive" };

  const [total, campaigns] = await Promise.all([
    prisma.campaign.count({ where }),
    prisma.campaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: parseInt(limit),
      skip: parseInt(offset),
      include: { company: { select: { id: true, name: true, email: true } } },
    }),
  ]);
  res.json({ total, campaigns: campaigns.map(serializeAdminCampaign) });
});

// GET /admin/campaigns/:id
router.get("/campaigns/:id", async (req, res) => {
  const c = await prisma.campaign.findUnique({
    where: { id: req.params.id },
    include: { company: { select: { id: true, name: true, email: true } } },
  });
  if (!c) return res.sendStatus(404);
  res.json(serializeAdminCampaign(c));
});

// PATCH /admin/campaigns/:id — admin can pause, cancel, or resume any campaign
router.patch("/campaigns/:id", async (req, res) => {
  const { status, note } = req.body || {};
  const allowed = ["scheduled", "paused", "cancelled", "running", "completed"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
  const c = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!c) return res.sendStatus(404);
  const updated = await prisma.campaign.update({
    where: { id: req.params.id },
    data: { status },
    include: { company: { select: { id: true, name: true, email: true } } },
  });
  // Notify company owner
  if (note) {
    const owner = await prisma.user.findFirst({
      where: { companyId: c.companyId, role: { in: ["OWNER", "ADMIN"] } },
      orderBy: { createdAt: "asc" },
    });
    if (owner) {
      await notify({ userId: owner.id, companyId: c.companyId, type: "campaign_status", message: `Your campaign "${c.name}" was marked ${status} by admin.${note ? " Note: " + note : ""}` }).catch(() => {});
    }
  }
  res.json(serializeAdminCampaign(updated));
});

// DELETE /admin/campaigns/:id
router.delete("/campaigns/:id", async (req, res) => {
  const c = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!c) return res.sendStatus(404);
  await prisma.campaign.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("[super-admin]", err?.message || err);
  res.status(500).json({ error: err?.message || "Server error" });
});

export default router;
