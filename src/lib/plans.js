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
    amount: 0,
    currency: "INR",
    period: "custom",
    features: { inbox: true, campaign: true, chatbot: true, automation: true, api: true, unlimitedAgents: true },
    agentLimit: 9999,
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

/** ₹500 / extra Enterprise team user (paise), billed on top of base subscription. */
export const EXTRA_SEAT_PAISE = 50000;
/** First seat (owner) is included in Enterprise base; each additional user adds EXTRA_SEAT_PAISE. */
export const ENTERPRISE_INCLUDED_SEATS = 1;

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

export function agentSeatLimit(plan) {
  const p = planFeatures(plan);
  if (p.features.unlimitedAgents) return Infinity;
  return Number(p.agentLimit || 0);
}
