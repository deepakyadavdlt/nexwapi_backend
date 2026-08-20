// lib/inboxAutomations.js — welcome, away, and outbound helpers for inbox automations
import { prisma } from "./prisma.js";
import { sendText, getEffectiveCreds, assertLiveCreds } from "./whatsappService.js";
import { isWithinWorkingHours } from "./businessHours.js";

const WELCOME_GAP_MS = 24 * 60 * 60 * 1000;
const AWAY_COOLDOWN_MS = 60 * 60 * 1000;

async function sendAutoText({ companyId, contact, text, automationSource }) {
  const creds = await getEffectiveCreds(companyId);
  assertLiveCreds(creds);
  const r = await sendText(contact.phone, text, creds);
  await prisma.message.create({
    data: {
      companyId,
      contactId: contact.id,
      waId: r.messages?.[0]?.id || null,
      direction: "out",
      type: "text",
      text,
      status: "sent",
      automationSource,
    },
  });
  return r;
}

/** Interakt: welcome on first message OR returning customer after 24h+ gap */
export async function shouldSendWelcome(contact, companyId, { isNewContact = false } = {}) {
  const s = await prisma.setting.findUnique({ where: { companyId } }).catch(() => null);
  if (!s?.welcomeEnabled || !s.welcomeMessage?.trim()) return false;

  if (isNewContact) return true;

  const inbounds = await prisma.message.findMany({
    where: { contactId: contact.id, direction: "in" },
    orderBy: { at: "desc" },
    take: 2,
  });
  if (inbounds.length < 2) return false;
  const gap = inbounds[0].at.getTime() - inbounds[1].at.getTime();
  return gap >= WELCOME_GAP_MS;
}

export async function maybeWelcome(contact, companyId, { isNewContact = false } = {}) {
  if (!(await shouldSendWelcome(contact, companyId, { isNewContact }))) return false;

  const s = await prisma.setting.findUnique({ where: { companyId } }).catch(() => null);
  if (!s?.welcomeMessage?.trim()) return false;

  try {
    await sendAutoText({ companyId, contact, text: s.welcomeMessage, automationSource: "welcome" });
    try {
      const commerce = await prisma.commerceSetting.findUnique({ where: { companyId } });
      if (commerce?.catalogInAutoReplies) {
        const { sendCollectionsList } = await import("./commerce.js");
        await sendCollectionsList(companyId, contact.phone);
      }
    } catch (e) {
      console.warn("[automation] catalog after welcome:", e.message);
    }
    const attrs = { ...(contact.attributes || {}), welcome_sent_at: new Date().toISOString() };
    await prisma.contact.update({ where: { id: contact.id }, data: { attributes: attrs } });
    console.log("[automation] welcome sent to", contact.phone);
    return true;
  } catch (e) {
    console.error("[automation] welcome failed:", e.message);
    return false;
  }
}

export async function maybeAway(contact, companyId) {
  const s = await prisma.setting.findUnique({ where: { companyId } }).catch(() => null);
  if (!s?.awayEnabled || !s.awayMessage?.trim()) return false;
  if (isWithinWorkingHours(s)) return false;

  const recentAway = await prisma.message.findFirst({
    where: {
      contactId: contact.id,
      direction: "out",
      automationSource: "away",
      at: { gte: new Date(Date.now() - AWAY_COOLDOWN_MS) },
    },
  });
  if (recentAway) return false;

  try {
    await sendAutoText({ companyId, contact, text: s.awayMessage, automationSource: "away" });
    console.log("[automation] away sent to", contact.phone);
    return true;
  } catch (e) {
    console.error("[automation] away failed:", e.message);
    return false;
  }
}

export async function clearDelayedReplyFlag(contactId) {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact?.attributes?.delayed_reply_sent_at) return;
  const attrs = { ...(contact.attributes || {}) };
  delete attrs.delayed_reply_sent_at;
  await prisma.contact.update({ where: { id: contactId }, data: { attributes: attrs } });
}

/** Sent counts for Basic Automations dashboard */
export async function getInboxAutomationStats(companyId) {
  const sources = ["welcome", "away", "delayed"];
  const counts = {};
  for (const src of sources) {
    counts[src] = await prisma.message.count({
      where: { companyId, direction: "out", automationSource: src },
    });
  }
  return {
    welcomeSent: counts.welcome,
    awaySent: counts.away,
    delayedSent: counts.delayed,
  };
}

export async function getInboxAutomationSettings(companyId) {
  const [s, stats, wa] = await Promise.all([
    prisma.setting.findUnique({ where: { companyId } }),
    getInboxAutomationStats(companyId),
    prisma.whatsAppAccount.findFirst({ where: { companyId, isDefault: true } }),
  ]);
  const setting = s || {};
  return {
    awayEnabled: Boolean(setting.awayEnabled),
    awayMessage: setting.awayMessage || "",
    welcomeEnabled: Boolean(setting.welcomeEnabled),
    welcomeMessage: setting.welcomeMessage || "",
    delayedEnabled: Boolean(setting.delayedEnabled),
    delayedMinutes: setting.delayedMinutes || 15,
    delayedMessage: setting.delayedMessage || "",
    workingHoursSlots: Array.isArray(setting.workingHoursSlots) && setting.workingHoursSlots.length
      ? setting.workingHoursSlots
      : null,
    hoursStart: setting.hoursStart ?? 9,
    hoursEnd: setting.hoursEnd ?? 18,
    days: setting.days || ["Mon", "Tue", "Wed", "Thu", "Fri"],
    whatsappConnected: Boolean(wa?.isConnected),
    ...stats,
  };
}

export async function updateInboxAutomationSettings(companyId, body, businessName = "Nexwapi") {
  const {
    awayEnabled, awayMessage, welcomeEnabled, welcomeMessage,
    delayedEnabled, delayedMinutes, delayedMessage, workingHoursSlots,
    hoursStart, hoursEnd, days,
  } = body || {};

  const data = {};
  if (awayEnabled !== undefined) data.awayEnabled = Boolean(awayEnabled);
  if (awayMessage !== undefined) data.awayMessage = String(awayMessage);
  if (welcomeEnabled !== undefined) data.welcomeEnabled = Boolean(welcomeEnabled);
  if (welcomeMessage !== undefined) data.welcomeMessage = String(welcomeMessage);
  if (delayedEnabled !== undefined) data.delayedEnabled = Boolean(delayedEnabled);
  if (delayedMinutes !== undefined) data.delayedMinutes = Math.max(1, Math.min(120, Number(delayedMinutes) || 15));
  if (delayedMessage !== undefined) data.delayedMessage = String(delayedMessage);
  if (workingHoursSlots !== undefined) data.workingHoursSlots = workingHoursSlots;
  if (hoursStart !== undefined) data.hoursStart = Number(hoursStart);
  if (hoursEnd !== undefined) data.hoursEnd = Number(hoursEnd);
  if (days !== undefined) data.days = days;

  if (Array.isArray(workingHoursSlots) && workingHoursSlots.length) {
    const daySet = [...new Set(workingHoursSlots.map((s) => s.day).filter(Boolean))];
    if (daySet.length) data.days = daySet;
  }

  await prisma.setting.upsert({
    where: { companyId },
    update: data,
    create: { companyId, businessName, ...data },
  });

  return getInboxAutomationSettings(companyId);
}
