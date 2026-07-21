// lib/campaignRunner.js — runs a broadcast campaign (used by the API route and the scheduler).
import { prisma } from "./prisma.js";
import { sendTemplate, sendTemplateWithParams } from "./whatsappService.js";

// Build the contact filter for a campaign audience: "All contacts", "Tag: x", or "Segment: name".
export async function resolveAudience(audience, companyId) {
  const where = { optedIn: true };
  if (companyId) where.companyId = companyId;
  if (!audience || /^all/i.test(audience)) return where;
  if (/^segment:/i.test(audience)) {
    const name = audience.replace(/^segment:\s*/i, "").trim();
    const seg = await prisma.segment.findFirst({ where: { name, ...(companyId ? { companyId } : {}) } });
    if (seg?.tags?.length) where.tags = seg.match === "all" ? { hasEvery: seg.tags } : { hasSome: seg.tags };
    return where;
  }
  where.tags = { has: audience.replace(/^tag:\s*/i, "").trim() };
  return where;
}

export async function resolveAudienceContacts(audience, companyId) {
  if (/^engaged:notreplied/i.test(audience)) {
    const cs = await prisma.contact.findMany({
      where: { optedIn: true, ...(companyId ? { companyId } : {}) },
      include: { messages: true },
    });
    return cs.filter((c) => c.messages.some((m) => m.direction === "out") && !c.messages.some((m) => m.direction === "in"));
  }
  if (/^engaged:notread/i.test(audience)) {
    const cs = await prisma.contact.findMany({
      where: { optedIn: true, ...(companyId ? { companyId } : {}) },
      include: { messages: true },
    });
    return cs.filter((c) => c.messages.some((m) => m.direction === "out" && m.status !== "read"));
  }
  return prisma.contact.findMany({ where: await resolveAudience(audience, companyId) });
}

export async function runCampaign(id) {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign || campaign.status === "running") return;

  const companyId = campaign.companyId;
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (company?.status === "SUSPENDED") {
    console.log(`[campaign] skip "${campaign.name}" — company SUSPENDED`);
    return;
  }
  // Pay-as-you-go: allow EXPIRED if freeAccess OR has message credits
  if (
    !company?.freeAccess &&
    (company?.status === "EXPIRED" || company?.plan === "expired") &&
    (company?.messageCredits || 0) < 1
  ) {
    console.log(`[campaign] skip "${campaign.name}" — EXPIRED with no credits`);
    return;
  }

  const { getCompanyCreds } = await import("./whatsappService.js");
  const { spendCredits, refundCredits, getPlatformPricing } = await import("./wallet.js");
  const creds = await getCompanyCreds(companyId);
  const pricing = await getPlatformPricing();
  const creditsNeeded = pricing.creditPerOutbound || 1;

  const tpl = await prisma.template.findFirst({ where: { name: campaign.template, companyId } });
  const varCount = tpl ? (tpl.body.match(/\{\{\d+\}\}/g) || []).length : 0;
  const lang = tpl?.language || "en";
  const contacts = await resolveAudienceContacts(campaign.audience, companyId);

  await prisma.campaign.update({
    where: { id },
    data: { status: "running", recipients: contacts.length, sent: 0, delivered: 0, read: 0, replied: 0 },
  });

  let sent = 0, delivered = 0;
  for (const c of contacts) {
    let debited = false;
    try {
      if (!company.freeAccess) {
        await spendCredits(companyId, creditsNeeded, "message_send", { campaignId: id, to: c.phone });
        debited = true;
      }
      const params = Array.from({ length: varCount }, () => c.name);
      const r = params.length
        ? await sendTemplateWithParams(c.phone, campaign.template, params, lang, creds)
        : await sendTemplate(c.phone, campaign.template, lang, creds);
      sent++; delivered++;
      let text = tpl?.body || `[Template: ${campaign.template}]`;
      params.forEach((p, i) => { text = text.replace(`{{${i + 1}}}`, p); });
      await prisma.message.create({
        data: {
          companyId,
          contactId: c.id,
          waId: r.messages?.[0]?.id || null,
          direction: "out",
          type: "template",
          text,
          status: "sent",
        },
      });
      await prisma.campaign.update({ where: { id }, data: { sent, delivered } });
    } catch (e) {
      console.error("[campaign] failed to", c.phone, ":", e.message);
      if (debited) {
        await refundCredits(companyId, creditsNeeded, "message_refund", {
          campaignId: id,
          to: c.phone,
          reason: e.message,
        }).catch(() => {});
      }
      if (e.code === "NO_CREDITS") break;
    }
  }
  await prisma.campaign.update({ where: { id }, data: { status: "completed", scheduledAt: null } });
  console.log(`[campaign] "${campaign.name}" done: ${sent}/${contacts.length} sent`);
}

export async function runDueCampaigns() {
  const due = await prisma.campaign.findMany({
    where: { status: "scheduled", scheduledAt: { not: null, lte: new Date() } },
  });
  for (const c of due) {
    console.log(`[scheduler] launching scheduled campaign "${c.name}"`);
    runCampaign(c.id).catch((e) => console.error("[scheduler] error:", e.message));
  }
}
