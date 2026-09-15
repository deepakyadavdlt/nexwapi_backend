// lib/assignmentEngine.js — conversation routing to agents
import { prisma } from "./prisma.js";
import { logActivity } from "./events.js";

export const CONTACT_TRAITS = [
  { id: "name", label: "Contact name" },
  { id: "phone", label: "Phone number" },
  { id: "email", label: "Email address" },
  { id: "userId", label: "External user ID" },
  { id: "tags", label: "Contact tags" },
];

export const TRAIT_CONDITIONS = {
  name: [{ id: "contains", label: "contains" }, { id: "equals", label: "equals" }],
  phone: [{ id: "contains", label: "contains" }, { id: "equals", label: "equals" }],
  email: [{ id: "contains", label: "contains" }, { id: "equals", label: "equals" }],
  userId: [{ id: "equals", label: "equals" }, { id: "contains", label: "contains" }],
  tags: [{ id: "is", label: "includes tag" }, { id: "is_not", label: "excludes tag" }],
};

function getTraitValue(contact, trait) {
  if (trait === "tags") return contact.tags || [];
  return contact[trait] ?? contact.attributes?.[trait] ?? "";
}

export function contactMatchesRule(contact, rule) {
  if (!rule.values?.length) return false;
  const trait = rule.trait;
  const cond = rule.condition || "contains";

  if (trait === "tags") {
    const tags = contact.tags || [];
    if (cond === "is" || cond === "equals") return rule.values.some((v) => tags.includes(v));
    if (cond === "is_not") return !rule.values.some((v) => tags.includes(v));
    if (cond === "contains") return rule.values.some((v) => tags.some((t) => t.toLowerCase().includes(String(v).toLowerCase())));
    return false;
  }

  const raw = String(getTraitValue(contact, trait) || "").toLowerCase();
  const targets = rule.values.map((v) => String(v).toLowerCase());
  if (cond === "equals" || cond === "is") return targets.some((t) => raw === t);
  if (cond === "is_not") return !targets.some((t) => raw === t);
  if (cond === "contains") return targets.some((t) => raw.includes(t));
  return false;
}

async function eligibleAgents(companyId, agentIds, onlineOnly) {
  const where = { companyId };
  if (agentIds?.length) where.id = { in: agentIds };
  if (onlineOnly) where.availability = "online";
  return prisma.agent.findMany({ where, orderBy: { createdAt: "asc" } });
}

async function pickLoadBalance(agents, companyId) {
  if (!agents.length) return null;
  const loads = await Promise.all(
    agents.map(async (a) => ({
      agent: a,
      n: await prisma.contact.count({
        where: { assignedAgentId: a.id, companyId, chatStatus: { in: ["open", "pending"] } },
      }),
    }))
  );
  loads.sort((a, b) => a.n - b.n);
  return loads[0].agent;
}

async function pickRoundRobin(agents, companyId, setting) {
  if (!agents.length) return null;
  const idx = (setting.roundRobinIndex || 0) % agents.length;
  const pick = agents[idx];
  await prisma.setting.update({
    where: { companyId },
    data: { roundRobinIndex: idx + 1 },
  });
  return pick;
}

/** Pick among rule's agents using rule mode or fallback to load balance. */
async function pickFromRuleAgents(rule, companyId, setting) {
  const agents = await eligibleAgents(companyId, rule.agentIds, setting.assignOnlineOnly);
  if (!agents.length) return null;
  const mode = setting.assignmentMode === "round_robin" ? "round_robin" : "load_balance";
  if (mode === "round_robin") return pickRoundRobin(agents, companyId, setting);
  return pickLoadBalance(agents, companyId);
}

async function pickDefaultAgent(companyId, setting) {
  const agents = await eligibleAgents(companyId, null, setting.assignOnlineOnly);
  if (!agents.length) return null;
  const mode = setting.assignmentMode || "load_balance";
  if (mode === "round_robin") return pickRoundRobin(agents, companyId, setting);
  if (mode === "load_balance") return pickLoadBalance(agents, companyId);
  return null;
}

function hasDefaultRouting(setting) {
  return setting.autoAssign !== false
    && setting.assignmentMode
    && setting.assignmentMode !== "none";
}

/** Assign contact to an agent based on rules + default mode. Returns agent id or null. */
export async function assignContactToAgent(contact, companyId, { force = false } = {}) {
  if (!force && contact.assignedAgentId && contact.chatStatus !== "resolved") {
    return contact.assignedAgentId;
  }

  const setting = await prisma.setting.findUnique({ where: { companyId } }).catch(() => null);
  if (!setting) return null;

  const rules = await prisma.assignmentRule.findMany({
    where: { companyId, enabled: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });

  const useDefault = hasDefaultRouting(setting);
  if (!rules.length && !useDefault) return null;

  let pick = null;
  let matchedRule = null;
  for (const rule of rules) {
    if (contactMatchesRule(contact, rule)) {
      pick = await pickFromRuleAgents(rule, companyId, setting);
      if (pick) {
        matchedRule = rule;
        break;
      }
    }
  }

  if (!pick && useDefault) pick = await pickDefaultAgent(companyId, setting);
  if (!pick) {
    console.log("[routing] no agent available for", contact.phone, matchedRule ? `(rule: ${matchedRule.name})` : "(default)");
    return null;
  }

  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      assignedAgentId: pick.id,
      chatStatus: contact.chatStatus === "resolved" ? "open" : (contact.chatStatus || "open"),
    },
  });

  const via = matchedRule ? `rule "${matchedRule.name}"` : `default (${setting.assignmentMode})`;
  logActivity(contact.id, "assign", `Routed to ${pick.name} via ${via}`);
  console.log("[routing] assigned", contact.phone, "->", pick.name, `(${via})`);
  return pick.id;
}

/** Summary for settings UI */
export async function getAssignmentSettings(companyId) {
  const [setting, rules, agentCount, onlineCount] = await Promise.all([
    prisma.setting.findUnique({ where: { companyId } }),
    prisma.assignmentRule.count({ where: { companyId, enabled: true } }),
    prisma.agent.count({ where: { companyId } }),
    prisma.agent.count({ where: { companyId, availability: "online" } }),
  ]);
  return {
    assignmentMode: setting?.assignmentMode || "none",
    autoAssign: setting?.autoAssign !== false,
    assignOnlineOnly: Boolean(setting?.assignOnlineOnly),
    enabledRules: rules,
    agentCount,
    onlineAgentCount: onlineCount,
  };
}
