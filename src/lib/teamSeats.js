import { prisma } from "./prisma.js";
import { hashPassword } from "./auth.js";
import { agentSeatLimit, normalizePlan } from "./plans.js";

const SALES_ROLES = new Set(["Sales Lead", "Sales Agent"]);
const ADMIN_ROLES = new Set(["Admin", "Super Admin", "Owner"]);

export const AGENT_ROLES = [
  "Owner",
  "Admin",
  "Teammate",
  "Super Admin",
  "Sales Lead",
  "Sales Agent",
];

function tempPassword() {
  return `Nw${Math.random().toString(36).slice(2, 8)}A1`;
}

export function mapAgentRoleToUserRole(role) {
  const r = String(role || "Teammate");
  if (r === "Owner") return "OWNER";
  if (ADMIN_ROLES.has(r) && r !== "Owner") return "ADMIN";
  return "AGENT";
}

export function agentKindFromRole(role) {
  return SALES_ROLES.has(String(role || "")) ? "sales" : "inbox";
}

export function splitName(fullName = "") {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function fullName(firstName, lastName, fallback = "") {
  const n = `${String(firstName || "").trim()} ${String(lastName || "").trim()}`.trim();
  return n || fallback || "Agent";
}

export async function companySeatUsage(companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const plan = normalizePlan(company?.plan || "trial");
  const limit = agentSeatLimit(plan);
  const used = await prisma.agent.count({ where: { companyId } });
  const salesUsed = await prisma.agent.count({
    where: { companyId, OR: [{ kind: "sales" }, { role: { in: [...SALES_ROLES] } }] },
  });
  return {
    plan,
    used,
    limit,
    unlimited: !Number.isFinite(limit),
    salesUsed,
    salesLimit: Number.isFinite(limit) ? limit : 9999,
  };
}

export async function assertCanAddAgent(companyId) {
  const { used, limit, unlimited } = await companySeatUsage(companyId);
  if (!unlimited && used >= limit) {
    const err = new Error(`Your plan allows ${limit} team user${limit === 1 ? "" : "s"}. Upgrade to add more.`);
    err.status = 403;
    err.code = "SEAT_LIMIT";
    err.limit = limit;
    err.used = used;
    throw err;
  }
}

export async function serializeAgent(agent, { usersByEmail } = {}) {
  const email = String(agent.email || "").toLowerCase();
  const user = usersByEmail?.get?.(email) || null;
  const lastLoginAt = user?.lastLoginAt ? user.lastLoginAt.getTime() : null;
  const joined = Boolean(lastLoginAt) || agent.inviteStatus === "joined";
  return {
    id: agent.id,
    companyId: agent.companyId,
    name: agent.name,
    firstName: agent.firstName || splitName(agent.name).firstName,
    lastName: agent.lastName || splitName(agent.name).lastName,
    email: agent.email,
    phone: agent.phone || user?.phone || "",
    role: agent.role,
    kind: agent.kind || agentKindFromRole(agent.role),
    color: agent.color,
    availability: agent.availability || "online",
    inviteStatus: joined ? "joined" : "pending",
    createdBy: agent.createdBy || "",
    teamId: agent.teamId || null,
    teamName: agent.team?.name || null,
    lastLoginAt,
    createdAt: agent.createdAt instanceof Date ? agent.createdAt.getTime() : agent.createdAt,
  };
}

export async function listAgentsEnriched(companyId) {
  const [agents, users] = await Promise.all([
    prisma.agent.findMany({
      where: { companyId },
      include: { team: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.user.findMany({
      where: { companyId },
      select: { email: true, lastLoginAt: true, phone: true, name: true },
    }),
  ]);
  const usersByEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u]));
  // Backfill inviteStatus when user has logged in
  await Promise.all(
    agents
      .filter((a) => a.inviteStatus !== "joined" && usersByEmail.get(String(a.email).toLowerCase())?.lastLoginAt)
      .map((a) =>
        prisma.agent.update({ where: { id: a.id }, data: { inviteStatus: "joined" } }).catch(() => {})
      )
  );
  return Promise.all(agents.map((a) => serializeAgent(a, { usersByEmail })));
}

export async function createAgentSeat(
  companyId,
  {
    name,
    firstName,
    lastName,
    email,
    phone = "",
    role = "Teammate",
    teamId = null,
    password,
    createdBy = "",
  } = {}
) {
  await assertCanAddAgent(companyId);
  const em = String(email).toLowerCase().trim();
  const fn = String(firstName || "").trim() || splitName(name).firstName;
  const ln = String(lastName || "").trim() || splitName(name).lastName;
  const displayName = fullName(fn, ln, name);
  const agentRole = AGENT_ROLES.includes(role) ? role : "Teammate";
  const kind = agentKindFromRole(agentRole);
  const colors = ["#25D366", "#128C7E", "#34B7F1", "#7C3AED", "#F59E0B", "#EF4444"];
  const count = await prisma.agent.count({ where: { companyId } });
  const plain = password && String(password).length >= 6 ? String(password) : tempPassword();

  if (teamId) {
    const team = await prisma.team.findFirst({ where: { id: teamId, companyId } });
    if (!team) {
      const err = new Error("Team not found");
      err.status = 400;
      throw err;
    }
  }

  const existingUser = await prisma.user.findUnique({ where: { email: em } });
  if (existingUser && existingUser.companyId !== companyId) {
    const err = new Error("This email is already used on another workspace");
    err.status = 409;
    throw err;
  }

  const agent = await prisma.agent.create({
    data: {
      companyId,
      name: displayName,
      firstName: fn,
      lastName: ln,
      email: em,
      phone: String(phone || "").trim(),
      role: agentRole,
      kind,
      color: colors[count % colors.length],
      inviteStatus: "pending",
      createdBy: String(createdBy || "").trim(),
      teamId: teamId || null,
    },
    include: { team: true },
  });

  let user = existingUser;
  if (!user) {
    user = await prisma.user.create({
      data: {
        name: displayName,
        email: em,
        phone: String(phone || "").trim() || null,
        password: await hashPassword(plain),
        role: mapAgentRoleToUserRole(agentRole),
        companyId,
      },
    });
  } else if (phone && !user.phone) {
    await prisma.user.update({ where: { id: user.id }, data: { phone: String(phone).trim() } }).catch(() => {});
  }

  const serialized = await serializeAgent(agent, {
    usersByEmail: new Map([[em, user]]),
  });

  return {
    agent: serialized,
    login: { email: em, password: existingUser ? null : plain },
  };
}

export async function updateAgentSeat(companyId, agentId, patch = {}) {
  const existing = await prisma.agent.findFirst({
    where: { id: agentId, companyId },
    include: { team: true },
  });
  if (!existing) {
    const err = new Error("Agent not found");
    err.status = 404;
    throw err;
  }

  if (existing.role === "Owner" && patch.role && patch.role !== "Owner") {
    const err = new Error("Owner role cannot be changed");
    err.status = 400;
    throw err;
  }

  let teamId = patch.teamId !== undefined ? patch.teamId : existing.teamId;
  if (teamId === "") teamId = null;
  if (teamId) {
    const team = await prisma.team.findFirst({ where: { id: teamId, companyId } });
    if (!team) {
      const err = new Error("Team not found");
      err.status = 400;
      throw err;
    }
  }

  const fn =
    patch.firstName !== undefined
      ? String(patch.firstName || "").trim()
      : existing.firstName || splitName(existing.name).firstName;
  const ln =
    patch.lastName !== undefined
      ? String(patch.lastName || "").trim()
      : existing.lastName || splitName(existing.name).lastName;
  const displayName =
    patch.name !== undefined
      ? String(patch.name || "").trim() || fullName(fn, ln)
      : fullName(fn, ln, existing.name);
  const role = patch.role && AGENT_ROLES.includes(patch.role) ? patch.role : existing.role;

  const updated = await prisma.agent.update({
    where: { id: existing.id },
    data: {
      name: displayName,
      firstName: fn,
      lastName: ln,
      phone: patch.phone !== undefined ? String(patch.phone || "").trim() : existing.phone,
      role,
      kind: agentKindFromRole(role),
      teamId: teamId ?? null,
      ...(patch.availability ? { availability: patch.availability } : {}),
    },
    include: { team: true },
  });

  await prisma.user
    .updateMany({
      where: { email: existing.email, companyId },
      data: {
        name: displayName,
        ...(patch.phone !== undefined ? { phone: String(patch.phone || "").trim() || null } : {}),
        ...(patch.role ? { role: mapAgentRoleToUserRole(role) } : {}),
      },
    })
    .catch(() => {});

  const user = await prisma.user.findFirst({ where: { email: existing.email, companyId } });
  return serializeAgent(updated, {
    usersByEmail: new Map([[String(existing.email).toLowerCase(), user]]),
  });
}

export async function resetAgentInvitePassword(companyId, agentId) {
  const agent = await prisma.agent.findFirst({ where: { id: agentId, companyId } });
  if (!agent) {
    const err = new Error("Agent not found");
    err.status = 404;
    throw err;
  }
  const plain = tempPassword();
  const user = await prisma.user.findFirst({ where: { email: agent.email, companyId } });
  if (!user) {
    await prisma.user.create({
      data: {
        name: agent.name,
        email: agent.email,
        phone: agent.phone || null,
        password: await hashPassword(plain),
        role: mapAgentRoleToUserRole(agent.role),
        companyId,
      },
    });
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data: { password: await hashPassword(plain), isActive: true },
    });
  }
  await prisma.agent.update({
    where: { id: agent.id },
    data: { inviteStatus: "pending" },
  });
  return { email: agent.email, password: plain, name: agent.name };
}

export async function ensureOwnerAgent(companyId, { name, email }) {
  const em = String(email).toLowerCase().trim();
  const existing = await prisma.agent.findFirst({ where: { companyId, email: em } });
  if (existing) return existing;
  const count = await prisma.agent.count({ where: { companyId } });
  const colors = ["#25D366", "#128C7E", "#34B7F1", "#7C3AED", "#F59E0B", "#EF4444"];
  const { firstName, lastName } = splitName(name);
  return prisma.agent.create({
    data: {
      companyId,
      name,
      firstName,
      lastName,
      email: em,
      role: "Owner",
      kind: "inbox",
      inviteStatus: "joined",
      createdBy: name,
      color: colors[count % colors.length],
    },
  });
}
