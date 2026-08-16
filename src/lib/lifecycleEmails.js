import { prisma } from "./prisma.js";
import { sendTrialExpiry, sendPlanExpiry } from "./mailer.js";
import fs from "fs";
import path from "path";

const FILE = path.resolve("data/email-notices.json");

function seen() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}
function mark(key) {
  const s = seen();
  s[key] = Date.now();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
}

export async function runLifecycleEmails() {
  const now = Date.now();
  const day = 86400000;
  const companies = await prisma.company.findMany({
    include: { users: { where: { role: { in: ["OWNER", "ADMIN"] } }, take: 1, orderBy: { createdAt: "asc" } }, subscription: true },
  });
  const log = seen();

  for (const c of companies) {
    const owner = c.users[0];
    if (!owner?.email) continue;

    if (c.status === "TRIAL" && c.trialEndsAt) {
      const left = Math.ceil((new Date(c.trialEndsAt).getTime() - now) / day);
      if (left <= 2) {
        const key = `trial:${c.id}:${left <= 0 ? "ended" : left}`;
        if (!log[key]) {
          await sendTrialExpiry(owner.email, owner.name, Math.max(0, left)).catch((e) => console.warn("[mail trial]", e.message));
          mark(key);
        }
      }
    }

    const exp = c.subscription?.expiresAt;
    if (c.status === "ACTIVE" && exp) {
      const left = Math.ceil((new Date(exp).getTime() - now) / day);
      if (left <= 3) {
        const key = `plan:${c.id}:${left <= 0 ? "ended" : left}`;
        if (!log[key]) {
          await sendPlanExpiry(owner.email, owner.name, c.plan).catch((e) => console.warn("[mail plan]", e.message));
          mark(key);
        }
      }
    }
  }
}
