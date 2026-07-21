// routes/superAdmin.js — platform Super Admin APIs
import express from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireSuperAdmin, signImpersonationToken } from "../lib/auth.js";
import { publicCompanyUser, uniqueSlug } from "../lib/tenant.js";
import { PLAN_CATALOG, normalizePlan } from "../lib/plans.js";
import { WA_LIVE } from "../config/whatsapp.js";
import { RAZORPAY_ENABLED } from "../lib/razorpay.js";
import { creditWallet, getPlatformPricing } from "../lib/wallet.js";

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

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
      waConnected: clients.filter((c) => c.whatsappConnected).length,
    },
    topClients: [...clients].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
    topCampaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      sent: c.sent,
      delivered: c.delivered,
      read: c.read,
      status: c.status,
      companyId: c.companyId,
    })),
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

router.post("/clients/:id/plan", async (req, res) => {
  let { plan } = req.body || {};
  plan = normalizePlan(plan === "pro" ? "growth" : plan);
  if (!["trial", "starter", "growth", "expired"].includes(plan)) {
    return res.status(400).json({ error: "invalid plan" });
  }
  const data = { plan };
  if (plan === "starter" || plan === "growth") {
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
  if (plan === "starter" || plan === "growth" || plan === "trial") {
    const { applyPlanCredits } = await import("../lib/wallet.js");
    await applyPlanCredits(company.id, plan, req.user.id).catch(() => {});
  }
  await prisma.auditLog.create({
    data: { companyId: company.id, userId: req.user.id, action: "plan_change", entity: "Company", entityId: company.id, meta: { plan } },
  }).catch(() => {});
  res.json(company);
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
  const plan = await prisma.plan.upsert({
    where: { key },
    update: {
      name: body.name,
      amount: body.amount,
      inbox: body.inbox,
      campaign: body.campaign,
      chatbot: body.chatbot,
      automation: body.automation,
      api: body.api,
      unlimitedAgents: body.unlimitedAgents,
      agentLimit: body.agentLimit,
      contactLimit: body.contactLimit,
      messageLimit: body.messageLimit,
      active: body.active,
    },
    create: {
      key,
      name: body.name || key,
      amount: body.amount ?? 0,
      inbox: body.inbox !== false,
      campaign: body.campaign !== false,
      chatbot: body.chatbot !== false,
      automation: body.automation !== false,
      api: Boolean(body.api),
      unlimitedAgents: Boolean(body.unlimitedAgents),
      agentLimit: body.agentLimit ?? 3,
      contactLimit: body.contactLimit ?? 1000,
      messageLimit: body.messageLimit ?? 5000,
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
  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: "refunded", refundId: `manual_${Date.now()}` },
  });
  res.json(updated);
});

/* ---------- Revenue ---------- */
router.get("/revenue", async (_req, res) => {
  const paid = await prisma.payment.findMany({ where: { status: "paid" } });
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay()); startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const sum = (from) => paid.filter((p) => (p.paidAt || p.createdAt) >= from).reduce((s, p) => s + p.amount, 0);
  const mrr = sum(startOfMonth);
  res.json({
    daily: sum(startOfDay),
    weekly: sum(startOfWeek),
    monthly: sum(startOfMonth),
    yearly: sum(startOfYear),
    mrr,
    arr: mrr * 12,
    total: paid.reduce((s, p) => s + p.amount, 0),
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
  const coupon = await prisma.coupon.update({ where: { id: req.params.id }, data: req.body || {} });
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
  const tickets = await prisma.ticket.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  res.json(tickets);
});

router.patch("/tickets/:id", async (req, res) => {
  const ticket = await prisma.ticket.update({ where: { id: req.params.id }, data: req.body || {} });
  res.json(ticket);
});

router.get("/logs", async (req, res) => {
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: Number(req.query.limit) || 100,
  });
  res.json(logs);
});

router.get("/campaigns", async (_req, res) => {
  const campaigns = await prisma.campaign.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { company: { select: { name: true } } },
  });
  res.json(campaigns.map((c) => ({ ...c, companyName: c.company?.name })));
});

export default router;
