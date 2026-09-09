// lib/tenant.js — multi-tenant helpers (companyId scoping)
import { prisma } from "./prisma.js";
import { normalizePlan, planFeatures, hasFeature } from "./plans.js";

export function isSuperAdmin(user) {
  return user?.role === "SUPER_ADMIN" || user?.role === "SuperAdmin";
}

export function isPartner(user) {
  return user?.role === "PARTNER";
}

export function isCompanyAdmin(user) {
  const r = user?.role;
  return r === "OWNER" || r === "Owner" || r === "ADMIN" || r === "Admin" || r === "PARTNER" || isSuperAdmin(user);
}

export const DEFAULT_BRANDING = {
  productName: "Nexwapi",
  logoUrl: null,
  primaryColor: "#0f8a3c",
  hideNexwapi: false,
  slug: null,
  websiteUrl: "",
  customDomain: "",
};

export function publicPartnerBranding(partner) {
  if (!partner) return { ...DEFAULT_BRANDING };
  return {
    productName: String(partner.productName || partner.name || "Workspace").trim() || "Workspace",
    logoUrl: partner.logoUrl || null,
    primaryColor: partner.primaryColor || "#0f8a3c",
    hideNexwapi: true,
    slug: partner.slug || null,
    websiteUrl: partner.websiteUrl || "",
    customDomain: partner.customDomain || "",
  };
}

export function resolveBranding(user, company) {
  // Partner agency console uses their own white-label brand.
  if (isPartner(user) && user?.partner) {
    return publicPartnerBranding(user.partner);
  }
  const partner = company?.partner || user?.partner;
  if (partner && !isSuperAdmin(user)) {
    return publicPartnerBranding(partner);
  }
  return { ...DEFAULT_BRANDING };
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
    // Partner JWT may still have null companyId until re-login — attach home CRM workspace.
    if (
      !companyIdOf(req)
      && req.user?.role === "PARTNER"
      && req.user?.partnerId
      && !req.user?.impersonating
    ) {
      const partner = await prisma.partner.findUnique({ where: { id: req.user.partnerId } }).catch(() => null);
      if (partner?.status === "ACTIVE") {
        const { ensurePartnerWorkspace } = await import("./partnerWorkspace.js");
        const ws = await ensurePartnerWorkspace(partner, {
          id: req.user.id,
          companyId: null,
          email: req.user.email,
        }).catch(() => null);
        if (ws?.id) req.user.companyId = ws.id;
      }
    }
    const companyId = companyIdOf(req);
    if (!companyId) {
      req.company = null;
      return next();
    }
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: {
        subscription: true,
        partner: true,
        whatsappAccounts: { where: { isDefault: true }, take: 1 },
      },
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

/**
 * Outbound allowed when:
 * - freeAccess, or
 * - trial / paid plan still active, or
 * - trial expired but wallet has messageCredits (pay-as-you-go).
 */
export function companyOutboundGate(company) {
  if (!company) {
    return { ok: false, status: 403, code: "NO_COMPANY", message: "No company linked to this account" };
  }
  if (company.partner && company.partner.status !== "ACTIVE") {
    return {
      ok: false,
      status: 403,
      code: "PARTNER_INACTIVE",
      message: "This workspace is temporarily unavailable. Contact your provider.",
    };
  }
  if (company.freeAccess) return { ok: true };
  if (company.status === "SUSPENDED") {
    return {
      ok: false,
      status: 403,
      code: "SUSPENDED",
      message: "Your account is suspended. Please upgrade or contact support.",
    };
  }
  const plan = normalizePlan(company.plan);
  const trialPast =
    company.status === "TRIAL" &&
    company.trialEndsAt &&
    new Date(company.trialEndsAt).getTime() < Date.now();
  const expired = company.status === "EXPIRED" || plan === "expired" || trialPast;
  if (expired && (Number(company.messageCredits) || 0) < 1) {
    return {
      ok: false,
      status: 402,
      code: "TRIAL_EXPIRED",
      message: "Your free trial has ended. Recharge your wallet or subscribe to continue sending messages, templates, and campaigns.",
    };
  }
  return { ok: true, expired, payg: Boolean(expired) };
}

export function assertCompanyOutbound(company) {
  const gate = companyOutboundGate(company);
  if (gate.ok) return gate;
  const err = new Error(gate.message);
  err.status = gate.status;
  err.code = gate.code;
  throw err;
}

export function requireActiveCompany(req, res, next) {
  if (isSuperAdmin(req.user) && !req.impersonateCompanyId) return next();
  if (req.allowBilling) return next();
  const gate = companyOutboundGate(req.company);
  if (gate.ok) return next();
  return res.status(gate.status).json({
    error: gate.message,
    code: gate.code,
    message: gate.message,
  });
}

/** Block messaging when suspended or trial ended with no wallet credits / subscription. */
export function requireNotSuspended(req, res, next) {
  if (isSuperAdmin(req.user) && !req.impersonateCompanyId) return next();
  const gate = companyOutboundGate(req.company);
  if (gate.ok) return next();
  return res.status(gate.status).json({
    error: gate.message,
    code: gate.code,
    message: gate.message,
  });
}

/** Alias — same gate as requireNotSuspended (outbound / messaging). */
export const requireOutboundAccess = requireNotSuspended;

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
  const trialEndsAt = company?.trialEndsAt ? new Date(company.trialEndsAt).getTime() : null;
  const daysLeft = trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / 86400000)) : null;
  const expired =
    !company?.freeAccess &&
    (company?.status === "EXPIRED" || plan === "expired" || (company?.status === "TRIAL" && daysLeft === 0));
  const messageCredits = company?.messageCredits ?? 0;
  const canOutbound =
    Boolean(company?.freeAccess) ||
    !expired ||
    Number(messageCredits) >= 1;
  // Pay-as-you-go after trial: unlock messaging features when wallet has credits.
  let features = { ...planFeatures(plan).features };
  if (expired && canOutbound) {
    features = {
      ...features,
      inbox: true,
      campaign: true,
      chatbot: true,
      automation: true,
    };
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || "",
    language: user.language || "en",
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
    canOutbound,
    features,
    agentLimit: planFeatures(plan).agentLimit,
    unlimitedAgents: Boolean(planFeatures(plan).features.unlimitedAgents),
    walletBalancePaise: company?.walletBalancePaise ?? 0,
    messageCredits,
    isSuperAdmin: isSuperAdmin(user),
    isPartner: isPartner(user),
    isPlatformStaff: isSuperAdmin(user) || ((user.role === "ADMIN" || user.role === "Admin") && !user.companyId && !isPartner(user)),
    partnerId: user?.partnerId || company?.partnerId || null,
    branding: resolveBranding(user, company),
    isActive: user.isActive !== false,
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
  };
}

export async function ensureDefaultPlans() {
  const rows = [
    { key: "trial", name: "Free Trial", amount: 0, api: true, unlimitedAgents: false, agentLimit: 2, contactLimit: 2000, messageLimit: 2000 },
    { key: "starter", name: "Starter", amount: 89900, api: false, unlimitedAgents: false, agentLimit: 2, contactLimit: 5000, messageLimit: 10000 },
    { key: "growth", name: "Growth", amount: 199900, api: true, unlimitedAgents: false, agentLimit: 5, contactLimit: 25000, messageLimit: 50000 },
    { key: "professional", name: "Professional", amount: 499900, api: true, unlimitedAgents: false, agentLimit: 12, contactLimit: 100000, messageLimit: 200000 },
    { key: "enterprise", name: "Enterprise", amount: 0, api: true, unlimitedAgents: true, agentLimit: 9999, contactLimit: 1000000, messageLimit: 10000000 },
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

const RESERVED_PARTNER_SLUGS = new Set([
  "app", "www", "api", "admin", "login", "signup", "partner", "partners",
  "dashboard", "static", "assets", "mail", "support", "help", "status",
]);

export async function uniquePartnerSlug(base) {
  let slug = slugify(base);
  if (RESERVED_PARTNER_SLUGS.has(slug)) slug = `${slug}-app`;
  let n = 0;
  while (await prisma.partner.findUnique({ where: { slug: n ? `${slug}-${n}` : slug } })) n++;
  return n ? `${slug}-${n}` : slug;
}
