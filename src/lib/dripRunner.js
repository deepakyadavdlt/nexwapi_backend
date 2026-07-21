// lib/dripRunner.js — sends drip campaign steps on schedule.
import { prisma } from "./prisma.js";
import { sendTemplate, sendTemplateWithParams, getCompanyCreds } from "./whatsappService.js";
import { spendCredits, refundCredits, getPlatformPricing } from "./wallet.js";

const HOUR = 60 * 60 * 1000;

// Enroll a set of contacts into a drip (first step scheduled by its delay).
export async function enrollContacts(dripId, contacts) {
  const drip = await prisma.drip.findUnique({ where: { id: dripId } });
  if (!drip || !Array.isArray(drip.steps) || !drip.steps.length) return 0;
  let enrolled = 0;
  for (const c of contacts) {
    const existing = await prisma.dripEnrollment.findFirst({ where: { dripId, contactId: c.id, status: "active" } });
    if (existing) continue;
    await prisma.dripEnrollment.create({
      data: { dripId, contactId: c.id, currentStep: 0, nextAt: new Date(Date.now() + (drip.steps[0].delayHours || 0) * HOUR) },
    });
    enrolled++;
  }
  return enrolled;
}

// Scheduler: process due drip steps.
export async function runDueDrips() {
  const due = await prisma.dripEnrollment.findMany({
    where: { status: "active", nextAt: { lte: new Date() } },
    include: { drip: true },
    take: 100,
  });
  const pricing = await getPlatformPricing();
  const creditsNeeded = pricing.creditPerOutbound || 1;

  for (const e of due) {
    const drip = e.drip;
    if (!drip?.enabled || !Array.isArray(drip.steps) || e.currentStep >= drip.steps.length) {
      await prisma.dripEnrollment.update({ where: { id: e.id }, data: { status: "completed" } });
      continue;
    }
    const step = drip.steps[e.currentStep];
    const contact = await prisma.contact.findUnique({ where: { id: e.contactId } });
    if (!contact) { await prisma.dripEnrollment.update({ where: { id: e.id }, data: { status: "completed" } }); continue; }

    const companyId = contact.companyId || drip.companyId;
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (company?.status === "SUSPENDED") continue;

    const creds = await getCompanyCreds(companyId);
    let debited = false;

    try {
      if (!company?.freeAccess) {
        await spendCredits(companyId, creditsNeeded, "message_send", {
          dripId: drip.id,
          to: contact.phone,
          template: step.template,
        });
        debited = true;
      }
      const tpl = await prisma.template.findFirst({ where: { name: step.template, companyId } });
      const varCount = tpl ? (tpl.body.match(/\{\{\d+\}\}/g) || []).length : 0;
      const params = Array.from({ length: varCount }, () => contact.name);
      const r = params.length
        ? await sendTemplateWithParams(contact.phone, step.template, params, tpl?.language || "en", creds)
        : await sendTemplate(contact.phone, step.template, tpl?.language || "en", creds);
      let text = tpl?.body || `[Template: ${step.template}]`;
      params.forEach((p, i) => { text = text.replace(`{{${i + 1}}}`, p); });
      await prisma.message.create({
        data: {
          companyId,
          contactId: contact.id,
          waId: r.messages?.[0]?.id || null,
          direction: "out",
          type: "template",
          text,
          status: "sent",
        },
      });
      console.log(`[drip] "${drip.name}" step ${e.currentStep + 1} -> ${contact.phone}`);
    } catch (err) {
      console.error("[drip] send failed:", err.message);
      if (debited) {
        await refundCredits(companyId, creditsNeeded, "message_refund", {
          dripId: drip.id,
          to: contact.phone,
          reason: err.message,
        }).catch(() => {});
      }
      if (err.code === "NO_CREDITS") {
        // Keep enrollment active; will retry when credits available
        continue;
      }
    }

    // Advance to the next step (or complete).
    const nextStep = e.currentStep + 1;
    if (nextStep < drip.steps.length) {
      await prisma.dripEnrollment.update({
        where: { id: e.id },
        data: { currentStep: nextStep, nextAt: new Date(Date.now() + (drip.steps[nextStep].delayHours || 0) * HOUR) },
      });
    } else {
      await prisma.dripEnrollment.update({ where: { id: e.id }, data: { status: "completed" } });
    }
  }
}
