// lib/plans.js — plan catalog + feature gates
export const PLAN_CATALOG = {
  trial: {
    key: "trial",
    name: "Free Trial",
    amount: 0,
    currency: "INR",
    period: "month",
    features: { inbox: true, campaign: true, chatbot: true, automation: true, api: true, unlimitedAgents: false },
    agentLimit: 2,
    contactLimit: 2000,
    messageLimit: 2000,
  },
  starter: {
    key: "starter",
    name: "Starter",
    amount: 89900,
    currency: "INR",
    period: "month",
    features: { inbox: true, campaign: true, chatbot: true, automation: true, api: false, unlimitedAgents: false },
    agentLimit: 2,
    contactLimit: 5000,
    messageLimit: 10000,
  },
  growth: {
    key: "growth",
    name: "Growth",
    amount: 199900,
    currency: "INR",
    period: "month",
    features: { inbox: true, campaign: true, chatbot: true, automation: true, api: true, unlimitedAgents: false },
    agentLimit: 5,
    contactLimit: 25000,
    messageLimit: 50000,
  },
  professional: {
    key: "professional",
    name: "Professional",
    amount: 499900,
    currency: "INR",
    period: "month",
    features: { inbox: true, campaign: true, chatbot: true, automation: true, api: true, unlimitedAgents: false },
    agentLimit: 12,
    contactLimit: 100000,
    messageLimit: 200000,
  },
  enterprise: {
    key: "enterprise",
    name: "Enterprise",
    amount: 0, // computed: Professional base + (seats - 12) × ₹500
    currency: "INR",
    period: "month",
    features: { inbox: true, campaign: true, chatbot: true, automation: true, api: true, unlimitedAgents: false },
    agentLimit: 12, // floor; real limit = company.purchasedSeats
    contactLimit: 1000000,
    messageLimit: 10000000,
  },
  expired: {
    key: "expired",
    name: "Expired",
    amount: 0,
    currency: "INR",
    features: { inbox: false, campaign: false, chatbot: false, automation: false, api: false, unlimitedAgents: false },
    agentLimit: 0,
    contactLimit: 0,
    messageLimit: 0,
  },
};

export const PAID_PLAN_KEYS = ["starter", "growth", "professional", "enterprise"];

/** Professional includes 12 team inbox users. Enterprise starts at 13+. */
export const PROFESSIONAL_SEAT_CAP = 12;
/** ₹500 / team inbox seat above Professional cap (paise). */
export const EXTRA_SEAT_PAISE = 50000;
/** Minimum Enterprise seat purchase (must be above Professional). */
export const ENTERPRISE_MIN_SEATS = PROFESSIONAL_SEAT_CAP + 1;

export const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export function normalizePlan(plan) {
  if (!plan) return "trial";
  if (plan === "pro") return "growth";
  if (plan === "advanced") return "professional";
  if (PLAN_CATALOG[plan]) return plan;
  return "trial";
}

export function isPaidPlan(plan) {
  return PAID_PLAN_KEYS.includes(normalizePlan(plan));
}

export function planFeatures(plan) {
  return PLAN_CATALOG[normalizePlan(plan)] || PLAN_CATALOG.trial;
}

export function hasFeature(plan, feature) {
  const f = planFeatures(plan).features;
  return Boolean(f[feature]);
}

export function normalizeEnterpriseSeats(seats) {
  const n = Math.floor(Number(seats) || 0);
  return Math.max(ENTERPRISE_MIN_SEATS, n);
}

/**
 * Enterprise monthly = Professional price + (seats - 12) × ₹500.
 * Example: 13 seats → ₹4,999 + ₹500; 20 seats → ₹4,999 + 8×₹500.
 */
export function enterpriseAmountPaise(seats, professionalBasePaise = PLAN_CATALOG.professional.amount) {
  const s = normalizeEnterpriseSeats(seats);
  const extra = Math.max(0, s - PROFESSIONAL_SEAT_CAP);
  const base = Math.max(0, Number(professionalBasePaise) || PLAN_CATALOG.professional.amount);
  return base + extra * EXTRA_SEAT_PAISE;
}

/** Catalog limit. For Enterprise, pass company.purchasedSeats via agentSeatLimitForCompany. */
export function agentSeatLimit(plan) {
  const p = planFeatures(plan);
  return Number(p.agentLimit || 0);
}

export function agentSeatLimitForCompany(company) {
  const plan = normalizePlan(company?.plan || "trial");
  if (plan === "enterprise") {
    const bought = Math.floor(Number(company?.purchasedSeats) || 0);
    return bought > 0 ? bought : ENTERPRISE_MIN_SEATS;
  }
  return agentSeatLimit(plan);
}
