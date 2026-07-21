// lib/plans.js — plan catalog + feature gates
export const PLAN_CATALOG = {
  trial: {
    key: "trial",
    name: "Free Trial",
    amount: 0,
    currency: "INR",
    features: { inbox: true, campaign: true, chatbot: true, automation: true, api: true, unlimitedAgents: true },
    agentLimit: 99,
    contactLimit: 5000,
    messageLimit: 10000,
  },
  starter: {
    key: "starter",
    name: "Starter",
    amount: 49900, // ₹499
    currency: "INR",
    features: { inbox: true, campaign: true, chatbot: true, automation: true, api: false, unlimitedAgents: false },
    agentLimit: 3,
    contactLimit: 2000,
    messageLimit: 5000,
  },
  growth: {
    key: "growth",
    name: "Growth",
    amount: 99900, // ₹999
    currency: "INR",
    features: { inbox: true, campaign: true, chatbot: true, automation: true, api: true, unlimitedAgents: true },
    agentLimit: 99,
    contactLimit: 50000,
    messageLimit: 100000,
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

// Map legacy "pro" → growth for backward compat
export function normalizePlan(plan) {
  if (!plan) return "trial";
  if (plan === "pro") return "growth";
  if (PLAN_CATALOG[plan]) return plan;
  return "trial";
}

export function planFeatures(plan) {
  return PLAN_CATALOG[normalizePlan(plan)] || PLAN_CATALOG.trial;
}

export function hasFeature(plan, feature) {
  const f = planFeatures(plan).features;
  return Boolean(f[feature]);
}
