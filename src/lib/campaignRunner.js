// lib/campaignRunner.js — runs a broadcast campaign (used by the API route and the scheduler).
import { prisma } from "./prisma.js";
import { sendResolvedTemplate, getEffectiveCreds, assertTenantOutbound } from "./whatsappService.js";
import { getTemplateHeaderMedia } from "./templateHeader.js";
import { buildSegmentContactWhere } from "./segmentFilters.js";

// Build the contact filter for a campaign audience: "All contacts", "Tag: x", or "Segment: name".
export async function resolveAudience(audience, companyId) {
  const where = {};
  if (companyId) where.companyId = companyId;
  if (!audience || /^all/i.test(audience)) return where;
  if (/^segment:/i.test(audience)) {
    const name = audience.replace(/^segment:\s*/i, "").trim();
    const seg = await prisma.segment.findFirst({ where: { name, ...(companyId ? { companyId } : {}) } });
    if (seg) return buildSegmentContactWhere(seg, companyId);
    return where;
  }
  if (/^contacts:/i.test(audience)) {
    const ids = audience.replace(/^contacts:\s*/i, "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length) return { ...where, id: { in: ids } };
    return where;
  }
  where.tags = { has: audience.replace(/^tag:\s*/i, "").trim() };
  return where;
}

export async function resolveAudienceContacts(audience, companyId) {
  if (/^engaged:notreplied/i.test(audience)) {
    const cs = await prisma.contact.findMany({
      where: { ...(companyId ? { companyId } : {}) },
      include: { messages: true },
    });
    return cs.filter((c) => c.messages.some((m) => m.direction === "out") && !c.messages.some((m) => m.direction === "in"));
  }
  if (/^engaged:notread/i.test(audience)) {
    const cs = await prisma.contact.findMany({
      where: { ...(companyId ? { companyId } : {}) },
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
    throw new Error("Account is suspended");
  }
  // Pay-as-you-go: allow EXPIRED if freeAccess OR has message credits
  if (
    !company?.freeAccess &&
    (company?.status === "EXPIRED" || company?.plan === "expired") &&
    (company?.messageCredits || 0) < 1
  ) {
    throw new Error("Plan expired — add wallet credits or upgrade");
  }

  const { spendCredits, refundCredits, getPlatformPricing, templateChargeCredits } = await import("./wallet.js");
  const creds = await getEffectiveCreds(companyId);
  assertTenantOutbound(creds);

  const wa = await prisma.whatsAppAccount.findFirst({ where: { companyId, isDefault: true } });
  if (wa?.wabaId) {
    const { applyPartnerBillingToAccount } = await import("./partnerBilling.js");
    const billing = await applyPartnerBillingToAccount(wa).catch(() => ({ ready: false }));
    if (!billing.ready && !billing.skipped) {
      console.warn(`[campaign] partner billing not ready for ${companyId}:`, billing.error || billing.reason);
    }
  }

  const pricing = await getPlatformPricing();
  const creditsNeeded = pricing.creditPerOutbound || 1;

  let tpl = await prisma.template.findFirst({ where: { name: campaign.template, companyId } });
  if (!tpl) throw new Error(`Template "${campaign.template}" not found. Create it under Templates first.`);
  if (String(tpl.status).toLowerCase() !== "approved") {
    const { refreshTemplateFromMeta } = await import("./templateSync.js");
    tpl = (await refreshTemplateFromMeta(companyId, campaign.template)) || tpl;
  }
  if (String(tpl.status).toLowerCase() !== "approved") {
    throw new Error(`Template "${campaign.template}" is still ${tpl.status} on WhatsApp. Campaigns send automatically once Meta marks it Approved.`);
  }
  const varCount = tpl ? (tpl.body.match(/\{\{\d+\}\}/g) || []).length : 0;
  const lang = tpl?.language || undefined;
  const contacts = await resolveAudienceContacts(campaign.audience, companyId);
  if (!contacts.length) throw new Error("No contacts in this audience");

  await prisma.campaign.update({
    where: { id },
    data: { status: "running", recipients: contacts.length, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 },
  });

  let sent = 0;
  let failed = 0;
  let lastError = "";
  for (const c of contacts) {
    let debited = false;
    try {
      if (!company.freeAccess) {
        const charge = await templateChargeCredits(companyId, campaign.template, {
          campaignId: id,
          to: c.phone,
        });
        if (charge.charged) debited = true;
      }
      const params = Array.from({ length: varCount }, () => c.name || "Customer");
      const header = await getTemplateHeaderMedia(companyId, campaign.template);
      const r = await sendResolvedTemplate(c.phone, campaign.template, {
        params,
        language: lang,
        body: tpl.body,
        creds,
        headerImageUrl: header.headerImageUrl || undefined,
      });
      sent++;
      let text = tpl?.body || `[Template: ${campaign.template}]`;
      params.forEach((p, i) => { text = text.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, "g"), p); });
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
      await prisma.campaign.update({ where: { id }, data: { sent } });
    } catch (e) {
      failed++;
      lastError = String(e.message || "Send failed");
      console.error("[campaign] failed to", c.phone, ":", e.message);
      await prisma.message.create({
        data: {
          companyId,
          contactId: c.id,
          direction: "out",
          type: "template",
          text: tpl?.body || `[Template: ${campaign.template}]`,
          status: "failed",
          error: String(e.message || "Send failed").slice(0, 500),
        },
      }).catch(() => {});
      await prisma.campaign.update({ where: { id }, data: { failed } }).catch(() => {});
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
  const status = sent === 0 ? "failed" : "completed";
  await prisma.campaign.update({ where: { id }, data: { status, scheduledAt: null, sent, failed } });
  console.log(`[campaign] "${campaign.name}" done: ${sent}/${contacts.length} sent, ${failed} failed`);
  try {
    const owner = await prisma.user.findFirst({
      where: { companyId: campaign.companyId, role: { in: ["OWNER", "ADMIN"] } },
      orderBy: { createdAt: "asc" },
    });
    if (owner?.email) {
      const { sendCampaignStatus } = await import("./mailer.js");
      await sendCampaignStatus(owner.email, campaign.name, status);
    }
  } catch (e) {
    console.warn("[mail campaign]", e.message);
  }
  return { sent, failed, recipients: contacts.length, error: lastError || undefined };
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
