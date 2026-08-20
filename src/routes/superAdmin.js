// routes/superAdmin.js — platform Super Admin APIs
import express from "express";
import { prisma } from "../lib/prisma.js";
import { buildSegmentContactWhere } from "../lib/segmentFilters.js";
import { requireAuth, requireSuperAdmin, signImpersonationToken, hashPassword } from "../lib/auth.js";
import { publicCompanyUser, uniqueSlug } from "../lib/tenant.js";
import { createAgentSeat, ensureOwnerAgent } from "../lib/teamSeats.js";
import { razorpay, RAZORPAY_ENABLED } from "../lib/razorpay.js";
import { PLAN_CATALOG, normalizePlan, isPaidPlan } from "../lib/plans.js";
import { WA_LIVE } from "../config/whatsapp.js";
import { creditWallet, getPlatformPricing } from "../lib/wallet.js";
import { otpGate } from "../lib/otp.js";
import { notify } from "../lib/notify.js";
import { hasPermission, permissionForPath, normalizePermissions, PERMISSIONS } from "../lib/permissions.js";
import multer from "multer";
import {
  fetchBusinessProfile, updateBusinessProfile, uploadProfilePicture, VERTICALS, platformWaCreds,
} from "../lib/waBusinessProfile.js";

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
  };
}

/* ---------- Dashboard overview ---------- */
router.get("/overview", async (_req, res) => {
  const [companies, payments, messagesToday, campaigns] = await Promise.all([
    prisma.company.findMany({ include: { payments: true, whatsappAccounts: true, users: { take: 1, orderBy: { createdAt: "asc" } } } }),
    prisma.payment.findMany({ where: { status: "paid" } }),
    prisma.message.count({
      where: { direction: "out", at: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
    }),
    prisma.campaign.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
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

/* ---------- Clients ---------- */
router.get("/clients", async (_req, res) => {
  const withOwners = await prisma.company.findMany({
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
        status: paid ? "ACTIVE" : "TRIAL",
        plan: ["trial", "starter", "growth", "professional", "enterprise"].includes(plan) ? plan : "trial",
        trialEndsAt,
        trialStartedAt: paid ? null : new Date(),
        messageCredits: credits || pricing.trialCredits,
        walletBalancePaise: 0,
        freeAccess: Boolean(req.body?.freeAccess),
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
  if (!(await otpGate(req, res, "client_delete"))) return;
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
  const amountPaise = Math.max(0, Number(req.body?.amountPaise) || 0);
  const credits = Math.max(0, Number(req.body?.credits) || 0);
  if (!amountPaise && !credits) return res.status(400).json({ error: "amountPaise or credits required" });
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not found" });
  const r = await creditWallet({
    companyId: company.id,
    amountPaise,
    credits,
    reason: "admin_grant",
    createdBy: req.user.id,
    meta: { note: req.body?.note || "Admin top-up" },
  });
  res.json(r.company);
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
    include: { users: { orderBy: { createdAt: "asc" } } },
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

/* ---------- WhatsApp accounts ---------- */
router.get("/whatsapp-accounts", async (_req, res) => {
  const accounts = await prisma.whatsAppAccount.findMany({
    orderBy: { createdAt: "desc" },
    include: { company: { select: { id: true, name: true, status: true, plan: true } } },
  });
  res.json(
    accounts.map((a) => ({
      id: a.id,
      companyId: a.companyId,
      companyName: a.company?.name,
      businessName: a.businessName || a.verifiedName,
      phoneNumber: a.displayPhoneNumber || a.phoneNumber,
      qualityRating: a.qualityRating || "UNKNOWN",
      messagingLimit: a.messagingLimit || "—",
      verificationStatus: a.verificationStatus || "unverified",
      webhookStatus: a.webhookStatus,
      connectedSince: a.connectedAt ? a.connectedAt.getTime() : null,
      isConnected: a.isConnected,
      status: a.status,
      lastError: a.lastError,
    }))
  );
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
router.get("/plans", async (_req, res) => {
  let plans = await prisma.plan.findMany({ orderBy: { amount: "asc" } });
  if (!plans.length) {
    plans = Object.values(PLAN_CATALOG).map((p) => ({
      key: p.key,
      name: p.name,
      amount: p.amount,
      ...p.features,
      agentLimit: p.agentLimit,
      contactLimit: p.contactLimit,
      messageLimit: p.messageLimit,
    }));
  }
  res.json(plans);
});

router.patch("/plans/:key", async (req, res) => {
  const key = normalizePlan(req.params.key);
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
    },
  });
  res.json(plan);
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
  if (RAZORPAY_ENABLED && payment.razorpayPaymentId) {
    try {
      const rf = await razorpay().payments.refund(payment.razorpayPaymentId, {
        amount: payment.amount,
        notes: { nexwapiPaymentId: payment.id, reason: req.body?.reason || "admin_refund" },
      });
      refundId = rf.id || refundId;
    } catch (e) {
      return res.status(400).json({ error: e?.error?.description || e.message || "Razorpay refund failed" });
    }
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
  if (!(await otpGate(req, res, "coupon_delete"))) return;
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
router.get("/system", async (_req, res) => {
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {}
  res.json({
    webhook: { ok: true, label: "Webhook endpoint" },
    meta: { ok: WA_LIVE, label: "Meta WhatsApp API", detail: WA_LIVE ? "live" : "demo / not configured" },
    razorpay: { ok: RAZORPAY_ENABLED, label: "Razorpay", detail: RAZORPAY_ENABLED ? "configured" : "missing keys" },
    database: { ok: dbOk, label: "PostgreSQL" },
    redis: { ok: false, label: "Redis", detail: "optional — not configured" },
    queue: { ok: true, label: "Campaign/Drip queue", detail: "in-process scheduler" },
    cron: { ok: true, label: "Scheduler", detail: "30s interval" },
    disk: { ok: true, label: "Disk", detail: "uploads/" },
    memory: { ok: true, label: "Memory", detail: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB heap` },
    cpu: { ok: true, label: "CPU", detail: `${(process.uptime() / 3600).toFixed(1)}h uptime` },
  });
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

router.get("/templates", async (_req, res) => {
  const templates = await prisma.template.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { company: { select: { name: true, email: true } } },
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
  if (!(await otpGate(req, res, "sales_lead_delete"))) return;
  await prisma.salesLead.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

router.get("/campaigns", async (_req, res) => {
  const campaigns = await prisma.campaign.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { company: { select: { name: true } } },
  });
  res.json(campaigns.map((c) => ({ ...c, companyName: c.company?.name })));
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
    res.json({
      ...profile,
      displayName: profile.about || "Nexwapi",
      verifiedName: "",
      phoneNumber: "",
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

const USER_ROLES = ["SUPER_ADMIN", "OWNER", "ADMIN", "AGENT", "MEMBER"];

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
  if (!USER_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot change your own role" });
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "User not found" });
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
  if (!(await otpGate(req, res, "user_delete"))) return;
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
