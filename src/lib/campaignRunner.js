// lib/campaignRunner.js — runs a broadcast campaign (used by the API route and the scheduler).
import { prisma } from "./prisma.js";
import { sendTemplate, sendTemplateWithParams } from "./whatsappService.js";

// Build the contact filter for a campaign audience: "All contacts", "Tag: x", or "Segment: name".
export async function resolveAudience(audience) {
  const where = { optedIn: true };
  if (!audience || /^all/i.test(audience)) return where;
  if (/^segment:/i.test(audience)) {
    const name = audience.replace(/^segment:\s*/i, "").trim();
    const seg = await prisma.segment.findFirst({ where: { name } });
    if (seg?.tags?.length) where.tags = seg.match === "all" ? { hasEvery: seg.tags } : { hasSome: seg.tags };
    return where;
  }
  where.tags = { has: audience.replace(/^tag:\s*/i, "").trim() };
  return where;
}

// Resolve an audience to a contact list, supporting engagement-based retargeting.
export async function resolveAudienceContacts(audience) {
  if (/^engaged:notreplied/i.test(audience)) {
    const cs = await prisma.contact.findMany({ where: { optedIn: true }, include: { messages: true } });
    return cs.filter((c) => c.messages.some((m) => m.direction === "out") && !c.messages.some((m) => m.direction === "in"));
  }
  if (/^engaged:notread/i.test(audience)) {
    const cs = await prisma.contact.findMany({ where: { optedIn: true }, include: { messages: true } });
    return cs.filter((c) => c.messages.some((m) => m.direction === "out" && m.status !== "read"));
  }
  return prisma.contact.findMany({ where: await resolveAudience(audience) });
}

// Send the campaign's template to every matching contact, updating progress.
export async function runCampaign(id) {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign || campaign.status === "running") return;

  const tpl = await prisma.template.findUnique({ where: { name: campaign.template } });
  const varCount = tpl ? (tpl.body.match(/\{\{\d+\}\}/g) || []).length : 0;
  const lang = tpl?.language || "en";
  const contacts = await resolveAudienceContacts(campaign.audience);

  await prisma.campaign.update({
    where: { id },
    data: { status: "running", recipients: contacts.length, sent: 0, delivered: 0, read: 0, replied: 0 },
  });

  let sent = 0, delivered = 0;
  for (const c of contacts) {
    try {
      const params = Array.from({ length: varCount }, () => c.name);
      const r = params.length
        ? await sendTemplateWithParams(c.phone, campaign.template, params, lang)
        : await sendTemplate(c.phone, campaign.template, lang);
      sent++; delivered++;
      let text = tpl?.body || `[Template: ${campaign.template}]`;
      params.forEach((p, i) => { text = text.replace(`{{${i + 1}}}`, p); });
      await prisma.message.create({
        data: { contactId: c.id, waId: r.messages?.[0]?.id || null, direction: "out", type: "template", text, status: "sent" },
      });
      await prisma.campaign.update({ where: { id }, data: { sent, delivered } });
    } catch (e) {
      console.error("[campaign] failed to", c.phone, ":", e.message);
    }
  }
  await prisma.campaign.update({ where: { id }, data: { status: "completed", scheduledAt: null } });
  console.log(`[campaign] "${campaign.name}" done: ${sent}/${contacts.length} sent`);
}

// Scheduler: run any campaigns whose scheduled time has arrived.
export async function runDueCampaigns() {
  const due = await prisma.campaign.findMany({
    where: { status: "scheduled", scheduledAt: { not: null, lte: new Date() } },
  });
  for (const c of due) {
    console.log(`[scheduler] launching scheduled campaign "${c.name}"`);
    runCampaign(c.id).catch((e) => console.error("[scheduler] error:", e.message));
  }
}
