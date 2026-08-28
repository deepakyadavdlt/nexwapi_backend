// routes/partner.js — agency console, scoped to one Partner
import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requirePartner, signImpersonationToken, hashPassword } from "../lib/auth.js";
import { publicCompanyUser, uniqueSlug, publicPartnerBranding } from "../lib/tenant.js";
import { createAgentSeat, ensureOwnerAgent } from "../lib/teamSeats.js";
import { PLAN_CATALOG, normalizePlan, isPaidPlan } from "../lib/plans.js";
import { creditWallet, debitWallet, getPlatformPricing } from "../lib/wallet.js";
import { notify } from "../lib/notify.js";
import { patchAsyncRouter } from "../lib/asyncRouter.js";
import {
  normalizeHost, normalizeWebsiteUrl, assertUniqueCustomDomain, bumpPartnerCorsCache, publicUploadUrl,
} from "../lib/partnerDomain.js";

const router = express.Router();
patchAsyncRouter(router);
router.use(requireAuth, requirePartner);

const DAY_MS = 86400000;

router.use(async (req, res, next) => {
  try {
    const row = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { permissions: true, isActive: true, companyId: true, role: true, partnerId: true },
    });
    if (!row || row.isActive === false) return res.status(403).json({ error: "Account disabled" });
    if (row.role !== "PARTNER") return res.status(403).json({ error: "Partner access only" });
    req.user.partnerId = row.partnerId;
    req.user.role = row.role;
    if (!row.partnerId) return res.status(403).json({ error: "Partner account is not linked" });
    const partner = await prisma.partner.findUnique({ where: { id: row.partnerId } });
    if (!partner) return res.status(403).json({ error: "Partner not found" });
    if (partner.status === "SUSPENDED") {
      return res.status(403).json({ error: "This partner account is suspended. Contact Nexwapi.", code: "PARTNER_SUSPENDED" });
    }
    req.partner = partner;
    next();
  } catch (e) {
    next(e);
  }
});

router.use((req, res, next) => {
  if (req.partner.status === "ACTIVE") return next();
  if (req.method === "GET" && (req.path === "/me" || req.path === "/" || req.path === "/overview")) return next();
  return res.status(403).json({
    error: "Partner is not activated yet. Nexwapi must mark payment received.",
    code: "PARTNER_PENDING",
  });
});

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
    partnerId: c.partnerId || null,
  };
}

function partnerWhere(req) {
  return { partnerId: req.partner.id };
}

async function scopedCompany(req, id, extraInclude = {}) {
  return prisma.company.findFirst({
    where: { id, ...partnerWhere(req) },
    include: extraInclude,
  });
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
    productName: p.productName || p.name,
    logoUrl: p.logoUrl || null,
    primaryColor: p.primaryColor || "#0f8a3c",
    customDomain: p.customDomain || "",
    websiteUrl: p.websiteUrl || "",
    branding: publicPartnerBranding(p),
    ...extra,
  };
}

router.get("/me", async (req, res) => {
  const clientCount = await prisma.company.count({ where: partnerWhere(req) });
  res.json({
    ...serializePartner(req.partner, { clientCount }),
    user: { id: req.user.id, email: req.user.email, name: req.user.name, role: "PARTNER" },
  });
});

router.get("/overview", async (req, res) => {
  const companies = await prisma.company.findMany({
    where: partnerWhere(req),
    include: { payments: true, whatsappAccounts: true, users: { take: 1, orderBy: { createdAt: "asc" } } },
  });
  const clients = companies.map(mapClient);
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const companyIds = companies.map((c) => c.id);
  const [messagesToday, inboundToday] = companyIds.length
    ? await Promise.all([
      prisma.message.count({ where: { companyId: { in: companyIds }, direction: "out", at: { gte: startToday } } }),
      prisma.message.count({ where: { companyId: { in: companyIds }, direction: "in", at: { gte: startToday } } }),
    ])
    : [0, 0];

  res.json({
    partner: serializePartner(req.partner, { clientCount: clients.length }),
    summary: {
      total: clients.length,
      maxClients: req.partner.maxClients,
      onTrial: clients.filter((c) => c.status === "TRIAL" && !c.trialExpired).length,
      active: clients.filter((c) => c.status === "ACTIVE").length,
      suspended: clients.filter((c) => c.suspended).length,
      expired: clients.filter((c) => c.trialExpired || c.status === "EXPIRED").length,
      waConnected: clients.filter((c) => c.whatsappConnected).length,
      credits: clients.reduce((s, c) => s + (c.messageCredits || 0), 0),
      messagesSentToday: messagesToday,
      inboundToday,
    },
    recent: clients.slice(0, 8),
  });
});

router.get("/clients", async (req, res) => {
  const withOwners = await prisma.company.findMany({
    where: partnerWhere(req),
    orderBy: { createdAt: "desc" },
    include: {
      payments: true,
      whatsappAccounts: true,
      users: { take: 5, orderBy: { createdAt: "asc" } },
    },
  });
  const clients = withOwners.map((c) => {
    const owner = c.users.find((u) => u.role === "OWNER" || u.role === "ADMIN") || c.users[0];
    return mapClient({ ...c, users: owner ? [owner] : [] });
  });
  const summary = {
    total: clients.length,
    maxClients: req.partner.maxClients,
    onTrial: clients.filter((c) => c.status === "TRIAL" && !c.trialExpired).length,
    starter: clients.filter((c) => c.plan === "starter").length,
    growth: clients.filter((c) => c.plan === "growth").length,
    expired: clients.filter((c) => c.trialExpired || c.status === "EXPIRED").length,
    suspended: clients.filter((c) => c.suspended).length,
    revenue: clients.reduce((s, c) => s + c.revenue, 0),
  };
  res.json({ clients, summary });
});

router.post("/clients", async (req, res) => {
  const used = await prisma.company.count({ where: partnerWhere(req) });
  if (used >= req.partner.maxClients) {
    return res.status(403).json({
      error: `Client limit reached (${req.partner.maxClients}). Ask Nexwapi to raise the limit.`,
      code: "CLIENT_LIMIT",
      limit: req.partner.maxClients,
      used,
    });
  }
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").toLowerCase().trim();
  const password = String(req.body?.password || "");
  const companyName = String(req.body?.company || req.body?.companyName || name).trim();
  const phone = String(req.body?.phone || "").trim();
  const plan = normalizePlan(req.body?.plan || "trial");
  const credits = Math.max(0, Number(req.body?.credits) || 0);
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  if (password && password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "An account with this email already exists" });
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
        partnerId: req.partner.id,
        status: paid ? "ACTIVE" : "TRIAL",
        plan: ["trial", "starter", "growth", "professional", "enterprise"].includes(plan) ? plan : "trial",
        trialEndsAt,
        trialStartedAt: paid ? null : new Date(),
        messageCredits: credits || pricing.trialCredits,
        walletBalancePaise: 0,
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
        action: "partner_client_create",
        entity: "Company",
        entityId: company.id,
        meta: { email, plan: company.plan, partnerId: req.partner.id },
      },
    }).catch(() => {});
    notify({
      audience: "admin",
      title: "Partner created a client",
      body: `${req.partner.name} · ${company.name} · ${email}`,
      href: "/admin/clients",
    }).catch(() => {});
    res.status(201).json({ ok: true, company, owner: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Email or company already exists" });
    res.status(400).json({ error: e.message || "Could not create client" });
  }
});

router.patch("/clients/:id", async (req, res) => {
  const company = await scopedCompany(req, req.params.id, { users: { orderBy: { createdAt: "asc" } } });
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
  res.json(updated);
});

router.post("/clients/:id/plan", async (req, res) => {
  const existing = await scopedCompany(req, req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
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
  const company = await prisma.company.update({ where: { id: existing.id }, data });
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
  res.json(company);
});

router.post("/clients/:id/suspend", async (req, res) => {
  const existing = await scopedCompany(req, req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const reason = req.body?.reason || "Suspended by partner";
  const company = await prisma.company.update({
    where: { id: existing.id },
    data: { status: "SUSPENDED", suspendedAt: new Date(), suspendReason: reason },
  });
  res.json(company);
});

router.post("/clients/:id/unsuspend", async (req, res) => {
  const company = await scopedCompany(req, req.params.id);
  if (!company) return res.status(404).json({ error: "not found" });
  const status = company.plan === "trial" ? "TRIAL" : company.plan === "expired" ? "EXPIRED" : "ACTIVE";
  const updated = await prisma.company.update({
    where: { id: company.id },
    data: { status, suspendedAt: null, suspendReason: null },
  });
  res.json(updated);
});

router.post("/clients/:id/trial", async (req, res) => {
  const company = await scopedCompany(req, req.params.id);
  if (!company) return res.status(404).json({ error: "not found" });
  const { days = 7, action = "extend" } = req.body || {};
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

router.post("/clients/:id/wallet-credit", async (req, res) => {
  const company = await scopedCompany(req, req.params.id);
  if (!company) return res.status(404).json({ error: "not found" });
  const amountPaise = Math.max(0, Math.floor(Number(req.body?.amountPaise) || 0));
  const credits = Math.max(0, Math.floor(Number(req.body?.credits) || 0));
  const note = String(req.body?.note || "").trim();
  if (!amountPaise && !credits) return res.status(400).json({ error: "amountPaise or credits required" });
  if (credits > 10_000_000 || amountPaise > 100_000_000) {
    return res.status(400).json({ error: "Amount is too large" });
  }
  const r = await creditWallet({
    companyId: company.id,
    amountPaise,
    credits,
    reason: "admin_grant",
    createdBy: req.user.id,
    meta: { note: note || "Partner credit", partnerId: req.partner.id },
  });
  res.json({
    walletBalancePaise: r.company.walletBalancePaise,
    messageCredits: r.company.messageCredits,
    txn: r.txn,
  });
});

router.post("/clients/:id/wallet-debit", async (req, res) => {
  const company = await scopedCompany(req, req.params.id);
  if (!company) return res.status(404).json({ error: "not found" });
  const amountPaise = Math.max(0, Math.floor(Number(req.body?.amountPaise) || 0));
  const credits = Math.max(0, Math.floor(Number(req.body?.credits) || 0));
  const note = String(req.body?.note || "").trim();
  if (!amountPaise && !credits) return res.status(400).json({ error: "amountPaise or credits required" });
  if (!note) return res.status(400).json({ error: "Note is required for debit" });
  try {
    const r = await debitWallet({
      companyId: company.id,
      amountPaise,
      credits,
      reason: "admin_debit",
      createdBy: req.user.id,
      meta: { note, partnerId: req.partner.id },
    });
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
  const company = await scopedCompany(req, req.params.id);
  if (!company) return res.status(404).json({ error: "not found" });
  const txns = await prisma.walletTransaction.findMany({
    where: { companyId: company.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({
    walletBalancePaise: company.walletBalancePaise,
    messageCredits: company.messageCredits,
    transactions: txns,
  });
});

router.post("/clients/:id/team-user", async (req, res) => {
  const company = await scopedCompany(req, req.params.id);
  if (!company) return res.status(404).json({ error: "not found" });
  const { name, email, role = "Agent", password } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  try {
    const { agent, login } = await createAgentSeat(company.id, { name, email, role, password });
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

router.post("/clients/:id/login-as", async (req, res) => {
  const company = await scopedCompany(req, req.params.id, { users: { orderBy: { createdAt: "asc" } } });
  if (!company) return res.status(404).json({ error: "Client not found" });
  const owner = company.users.find((u) => u.role === "OWNER" || u.role === "Owner") || company.users[0];
  if (!owner) return res.status(404).json({ error: "No user on this company" });
  const token = signImpersonationToken(req.user, owner);
  await prisma.auditLog.create({
    data: {
      companyId: company.id,
      userId: req.user.id,
      action: "partner_login_as",
      entity: "User",
      entityId: owner.id,
      meta: { partnerId: req.partner.id },
    },
  }).catch(() => {});
  res.json({
    token,
    user: { ...publicCompanyUser(owner, { ...company, partner: req.partner }), impersonating: true, impersonatedBy: req.user.id },
  });
});

router.patch("/branding", async (req, res) => {
  const data = {};
  if (req.body?.productName != null) data.productName = String(req.body.productName).trim().slice(0, 60);
  if (req.body?.logoUrl != null) data.logoUrl = String(req.body.logoUrl).trim() || null;
  if (req.body?.primaryColor != null) {
    const color = String(req.body.primaryColor).trim();
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) data.primaryColor = color;
  }
  if (req.body?.customDomain != null) {
    const host = String(req.body.customDomain).trim() ? normalizeHost(req.body.customDomain) : null;
    if (String(req.body.customDomain).trim() && !host) {
      return res.status(400).json({ error: "Enter a valid domain like crm.yourcompany.com (not nexwapi.com)." });
    }
    try {
      await assertUniqueCustomDomain(prisma, host, req.partner.id);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    data.customDomain = host;
  }
  if (req.body?.websiteUrl != null) data.websiteUrl = normalizeWebsiteUrl(req.body.websiteUrl);
  const partner = await prisma.partner.update({ where: { id: req.partner.id }, data });
  req.partner = partner;
  bumpPartnerCorsCache();
  res.json(serializePartner(partner));
});

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.post("/branding/logo", logoUpload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file?.buffer) return res.status(400).json({ error: "Upload a PNG, JPG, or SVG logo (max 2MB)." });
  const mime = String(file.mimetype || "");
  const map = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };
  const ext = map[mime];
  if (!ext) return res.status(400).json({ error: "Logo must be PNG, JPG, WEBP, or SVG." });
  const dir = path.resolve("uploads/branding");
  fs.mkdirSync(dir, { recursive: true });
  const stored = `branding/${req.partner.id}.${ext}`;
  fs.writeFileSync(path.resolve("uploads", stored), file.buffer);
  const logoUrl = publicUploadUrl(req, stored);
  const partner = await prisma.partner.update({
    where: { id: req.partner.id },
    data: { logoUrl },
  });
  req.partner = partner;
  res.json(serializePartner(partner));
});

router.get("/tickets", async (req, res) => {
  const companies = await prisma.company.findMany({ where: partnerWhere(req), select: { id: true } });
  const ids = companies.map((c) => c.id);
  const tickets = ids.length
    ? await prisma.ticket.findMany({
      where: { companyId: { in: ids } },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    : [];
  res.json(tickets.map((t) => ({
    id: t.id,
    subject: t.subject,
    body: t.body,
    status: t.status,
    priority: t.priority,
    createdAt: t.createdAt.getTime ? t.createdAt.getTime() : t.createdAt,
    companyId: t.companyId,
  })));
});

router.patch("/tickets/:id", async (req, res) => {
  const companies = await prisma.company.findMany({ where: partnerWhere(req), select: { id: true } });
  const ids = companies.map((c) => c.id);
  const existing = await prisma.ticket.findFirst({ where: { id: req.params.id, companyId: { in: ids } } });
  if (!existing) return res.status(404).json({ error: "not found" });
  const data = {};
  if (["open", "pending", "closed"].includes(req.body?.status)) data.status = req.body.status;
  if (["low", "normal", "high", "urgent"].includes(req.body?.priority)) data.priority = req.body.priority;
  if (req.body?.adminReply != null) data.adminReply = String(req.body.adminReply).slice(0, 5000);
  const ticket = await prisma.ticket.update({ where: { id: existing.id }, data });
  res.json(ticket);
});

export default router;
