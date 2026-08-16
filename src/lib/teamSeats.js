import { prisma } from "./prisma.js";
import { hashPassword } from "./auth.js";
import { agentSeatLimit, normalizePlan } from "./plans.js";

function tempPassword() {
  return `Nw${Math.random().toString(36).slice(2, 8)}A1`;
}

export async function companySeatUsage(companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const plan = normalizePlan(company?.plan || "trial");
  const limit = agentSeatLimit(plan);
  const used = await prisma.agent.count({ where: { companyId } });
  return { plan, used, limit, unlimited: !Number.isFinite(limit) };
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

export async function createAgentSeat(companyId, { name, email, role = "Agent", password } = {}) {
  await assertCanAddAgent(companyId);
  const em = String(email).toLowerCase().trim();
  const colors = ["#25D366", "#128C7E", "#34B7F1", "#7C3AED", "#F59E0B", "#EF4444"];
  const count = await prisma.agent.count({ where: { companyId } });
  const plain = password && String(password).length >= 6 ? String(password) : tempPassword();

  const existingUser = await prisma.user.findUnique({ where: { email: em } });
  if (existingUser && existingUser.companyId !== companyId) {
    const err = new Error("This email is already used on another workspace");
    err.status = 409;
    throw err;
  }

  const agent = await prisma.agent.create({
    data: { companyId, name, email: em, role, color: colors[count % colors.length] },
  });

  let user = existingUser;
  if (!user) {
    user = await prisma.user.create({
      data: {
        name,
        email: em,
        password: await hashPassword(plain),
        role: role === "Admin" || role === "ADMIN" ? "ADMIN" : "AGENT",
        companyId,
      },
    });
  }

  return { agent: { ...agent, createdAt: agent.createdAt.getTime() }, login: { email: em, password: existingUser ? null : plain } };
}

export async function ensureOwnerAgent(companyId, { name, email }) {
  const em = String(email).toLowerCase().trim();
  const existing = await prisma.agent.findFirst({ where: { companyId, email: em } });
  if (existing) return existing;
  const count = await prisma.agent.count({ where: { companyId } });
  const colors = ["#25D366", "#128C7E", "#34B7F1", "#7C3AED", "#F59E0B", "#EF4444"];
  return prisma.agent.create({
    data: { companyId, name, email: em, role: "Owner", color: colors[count % colors.length] },
  });
}
