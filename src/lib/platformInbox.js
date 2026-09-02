/**
 * Platform WhatsApp inbox — messages to PLATFORM_MESSAGING_PHONE land here
 * and appear in Super Admin → WhatsApp Inbox.
 */
import { prisma } from "./prisma.js";
import { WA } from "../config/whatsapp.js";

const PLATFORM_SLUG = "nexwapi-platform";

export function platformPhoneDigits() {
  return String(
    process.env.PLATFORM_MESSAGING_PHONE ||
    process.env.ADMIN_MESSAGING_PHONE ||
    "917631100654"
  ).replace(/\D/g, "");
}

export function platformPhoneDisplay() {
  const d = platformPhoneDigits();
  if (d.startsWith("91") && d.length === 12) {
    return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  }
  return d ? `+${d}` : "";
}

export function platformPhoneNumberId() {
  return WA.phoneNumberId ? String(WA.phoneNumberId) : null;
}

/** Ensure platform number always routes to the platform company inbox. */
export async function reclaimPlatformWhatsAppAccount(platformCompanyId) {
  const phoneNumberId = platformPhoneNumberId();
  if (!phoneNumberId || !platformCompanyId) return;

  const misrouted = await prisma.whatsAppAccount.findMany({
    where: { phoneNumberId, companyId: { not: platformCompanyId } },
    select: { id: true, companyId: true },
  });

  if (misrouted.length) {
    console.warn(
      "[platformInbox] reclaiming platform phone_number_id from",
      misrouted.map((a) => a.companyId).join(", ")
    );
    await prisma.whatsAppAccount.updateMany({
      where: { phoneNumberId },
      data: { companyId: platformCompanyId, isDefault: true, isConnected: true },
    });
  }

  await linkPlatformWhatsApp(platformCompanyId);
}

/** Ensure a dedicated company owns the platform WhatsApp number inbox. */
export async function ensurePlatformCompany() {
  const explicit = String(process.env.PLATFORM_COMPANY_ID || "").trim();
  if (explicit) {
    const co = await prisma.company.findUnique({ where: { id: explicit } });
    if (co) {
      await reclaimPlatformWhatsAppAccount(co.id);
      return co.id;
    }
  }

  let co = await prisma.company.findFirst({ where: { slug: PLATFORM_SLUG } });
  if (!co) {
    co = await prisma.company.create({
      data: {
        name: "Nexwapi Platform Inbox",
        slug: PLATFORM_SLUG,
        email: (process.env.ADMIN_EMAIL || "platform@nexwapi.com").toLowerCase(),
        status: "ACTIVE",
        plan: "enterprise",
        freeAccess: true,
        messageCredits: 100000,
      },
    });
  }

  await reclaimPlatformWhatsAppAccount(co.id);
  return co.id;
}

async function linkPlatformWhatsApp(companyId) {
  if (!WA.phoneNumberId || !WA.accessToken) return;
  const phoneNumberId = String(WA.phoneNumberId);
  const digits = platformPhoneDigits();
  const existing = await prisma.whatsAppAccount.findFirst({
    where: { phoneNumberId },
    orderBy: { isDefault: "desc" },
  });
  const data = {
    companyId,
    phoneNumberId,
    accessToken: WA.accessToken,
    wabaId: WA.wabaId || null,
    isConnected: true,
    isDefault: true,
    status: "connected",
    phoneNumber: digits,
    displayPhoneNumber: platformPhoneDisplay(),
    businessName: "Nexwapi",
    verifiedName: "Nexwapi",
    lastSyncAt: new Date(),
    webhookStatus: "connected",
  };
  if (existing) {
    await prisma.whatsAppAccount.update({ where: { id: existing.id }, data });
  } else {
    await prisma.whatsAppAccount.create({ data });
  }
}

let cachedPlatformCompanyId = null;

export async function getPlatformCompanyId() {
  if (cachedPlatformCompanyId) {
    const ok = await prisma.company.findUnique({ where: { id: cachedPlatformCompanyId }, select: { id: true } });
    if (ok) return cachedPlatformCompanyId;
    cachedPlatformCompanyId = null;
  }
  try {
    cachedPlatformCompanyId = await ensurePlatformCompany();
    return cachedPlatformCompanyId;
  } catch (e) {
    console.warn("[platformInbox]", e?.message || e);
    return null;
  }
}

/** True when this webhook event is for the platform support number (+91 76311 00654). */
export function isPlatformPhoneNumberId(phoneNumberId) {
  const pid = platformPhoneNumberId();
  return Boolean(pid && phoneNumberId && String(phoneNumberId) === pid);
}

export async function buildPlatformConversations(companyId) {
  const contacts = await prisma.contact.findMany({
    where: { companyId },
    include: { messages: { orderBy: { at: "desc" }, take: 50 } },
  });

  const phoneSet = new Set(contacts.map((c) => c.phone));
  const clientMatches = phoneSet.size
    ? await prisma.contact.findMany({
        where: { phone: { in: [...phoneSet] }, companyId: { not: companyId } },
        include: { company: { select: { id: true, name: true, plan: true, email: true } } },
      })
    : [];
  const clientByPhone = new Map(clientMatches.map((c) => [c.phone, c.company]));

  return contacts
    .map((c) => {
      const last = c.messages[0];
      const unread = c.messages.filter((m) => m.direction === "in" && m.status !== "read").length;
      const matched = clientByPhone.get(c.phone);
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        color: c.color,
        tags: c.tags,
        lastMessage: last ? last.text : "No messages yet",
        lastAt: last ? last.at.getTime() : c.createdAt.getTime(),
        lastDirection: last ? last.direction : null,
        unread,
        chatStatus: c.chatStatus,
        clientCompany: matched?.name || null,
        clientPlan: matched?.plan || null,
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}
