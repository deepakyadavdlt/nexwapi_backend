// lib/tenant.js — multi-tenant helpers (companyId scoping)
import { prisma } from "./prisma.js";
import { normalizePlan, planFeatures, hasFeature } from "./plans.js";

export function isSuperAdmin(user) {
  return user?.role === "SUPER_ADMIN" || user?.role === "SuperAdmin";
}

export function isCompanyAdmin(user) {
  const r = user?.role;
  return r === "OWNER" || r === "Owner" || r === "ADMIN" || r === "Admin" || isSuperAdmin(user);
}

/** Resolve companyId for the current request (impersonation-aware). */
export function companyIdOf(req) {
  if (req.impersonateCompanyId) return req.impersonateCompanyId;
  return req.user?.companyId || null;
}

export function tenantWhere(req, extra = {}) {
  const companyId = companyIdOf(req);
  if (!companyId) return { id: "__none__", ...extra }; // force empty
  return { companyId, ...extra };
}

/** Load company + effective plan/status onto req. */
export async function attachCompany(req, _res, next) {
  try {
    const companyId = companyIdOf(req);
    if (!companyId) {
      req.company = null;
      return next();
    }
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: { subscription: true, whatsappAccounts: { where: { isDefault: true }, take: 1 } },
    });
    req.company = company;
    // Soft-expire trial
    if (company && company.status === "TRIAL" && company.trialEndsAt && new Date(company.trialEndsAt) < new Date()) {
      await prisma.company.update({
        where: { id: company.id },
        data: { status: "EXPIRED", plan: "expired" },
      }).catch(() => {});
      company.status = "EXPIRED";
      company.plan = "expired";
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function requireActiveCompany(req, res, next) {
  if (isSuperAdmin(req.user) && !req.impersonateCompanyId) return next();
  const c = req.company;
  if (!c) return res.status(403).json({ error: "No company linked to this account" });
  if (c.freeAccess) return next(); // Super Admin free grant
  if (c.status === "SUSPENDED") {
    if (req.allowBilling) return next();
    return res.status(403).json({
      error: "Account suspended",
      code: "SUSPENDED",
      message: "Your account is suspended. Please upgrade or contact support.",
    });
  }
  if (c.status === "EXPIRED" || c.plan === "expired") {
    if (req.allowBilling) return next();
    return res.status(402).json({
      error: "Trial ended",
      code: "TRIAL_EXPIRED",
      message: "Your free trial has ended. Please upgrade to continue.",
    });
  }
  next();
}

/** Block messaging features when suspended (billing stays open). */
export function requireNotSuspended(req, res, next) {
  if (isSuperAdmin(req.user) && !req.impersonateCompanyId) return next();
  if (req.company?.status === "SUSPENDED") {
    return res.status(403).json({ error: "Account suspended", code: "SUSPENDED" });
  }
  next();
}

export function requireFeature(feature) {
  return (req, res, next) => {
    if (isSuperAdmin(req.user) && !req.impersonateCompanyId) return next();
    const plan = normalizePlan(req.company?.plan || "trial");
    if (!hasFeature(plan, feature)) {
      return res.status(403).json({
        error: `Your plan does not include ${feature}`,
        code: "FEATURE_LOCKED",
        feature,
        plan,
      });
    }
    next();
  };
}

export function publicCompanyUser(user, company) {
  const plan = normalizePlan(company?.plan || user?.plan || "trial");
  const features = planFeatures(plan).features;
  const trialEndsAt = company?.trialEndsAt ? new Date(company.trialEndsAt).getTime() : null;
  const daysLeft = trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / 86400000)) : null;
  const expired =
    !company?.freeAccess &&
    (company?.status === "EXPIRED" || plan === "expired" || (company?.status === "TRIAL" && daysLeft === 0));
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    companyId: company?.id || user.companyId || null,
    companyName: company?.name || null,
    plan,
    planLegacy: plan === "growth" ? "pro" : plan,
    status: company?.status || "TRIAL",
    suspended: company?.status === "SUSPENDED",
    freeAccess: Boolean(company?.freeAccess),
    trialEndsAt,
    trialDaysLeft: daysLeft,
    trialExpired: expired,
    features,
    walletBalancePaise: company?.walletBalancePaise ?? 0,
    messageCredits: company?.messageCredits ?? 0,
    isSuperAdmin: isSuperAdmin(user),
  };
}

export async function ensureDefaultPlans() {
  const rows = [
    { key: "trial", name: "Free Trial", amount: 0, api: true, unlimitedAgents: true, agentLimit: 99, contactLimit: 5000, messageLimit: 10000 },
    { key: "starter", name: "Starter", amount: 49900, api: false, unlimitedAgents: false, agentLimit: 3, contactLimit: 2000, messageLimit: 5000 },
    { key: "growth", name: "Growth", amount: 99900, api: true, unlimitedAgents: true, agentLimit: 99, contactLimit: 50000, messageLimit: 100000 },
    { key: "expired", name: "Expired", amount: 0, api: false, unlimitedAgents: false, agentLimit: 0, contactLimit: 0, messageLimit: 0, inbox: false, campaign: false, chatbot: false, automation: false },
  ];
  for (const r of rows) {
    await prisma.plan.upsert({
      where: { key: r.key },
      update: {
        name: r.name,
        amount: r.amount,
        api: r.api ?? false,
        unlimitedAgents: r.unlimitedAgents ?? false,
        agentLimit: r.agentLimit,
        contactLimit: r.contactLimit,
        messageLimit: r.messageLimit,
        inbox: r.inbox !== false,
        campaign: r.campaign !== false,
        chatbot: r.chatbot !== false,
        automation: r.automation !== false,
      },
      create: {
        key: r.key,
        name: r.name,
        amount: r.amount,
        api: r.api ?? false,
        unlimitedAgents: r.unlimitedAgents ?? false,
        agentLimit: r.agentLimit,
        contactLimit: r.contactLimit,
        messageLimit: r.messageLimit,
        inbox: r.inbox !== false,
        campaign: r.campaign !== false,
        chatbot: r.chatbot !== false,
        automation: r.automation !== false,
      },
    });
  }
}

export async function ensureDefaultCoupons() {
  const coupons = [
    { code: "WELCOME50", description: "50% off first month", discountPct: 50, freeDays: 0 },
    { code: "FREE30", description: "30 extra trial days", discountPct: 0, freeDays: 30 },
    { code: "YEARLY20", description: "20% off yearly", discountPct: 20, freeDays: 0 },
  ];
  for (const c of coupons) {
    await prisma.coupon.upsert({
      where: { code: c.code },
      update: { description: c.description, discountPct: c.discountPct, freeDays: c.freeDays, active: true },
      create: c,
    });
  }
}

export function slugify(name) {
  return String(name || "company")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "company";
}

export async function uniqueSlug(base) {
  let slug = slugify(base);
  let n = 0;
  while (await prisma.company.findUnique({ where: { slug: n ? `${slug}-${n}` : slug } })) n++;
  return n ? `${slug}-${n}` : slug;
}
