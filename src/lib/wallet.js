// lib/wallet.js — wallet balance + message credits
import { prisma } from "./prisma.js";

export async function getPlatformPricing() {
  return prisma.platformSetting.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });
}

export function creditsFromPaise(paise, creditsPerRupee) {
  const rupees = Math.floor(Number(paise) / 100);
  return rupees * (creditsPerRupee || 10);
}

/** Credit wallet + message credits (recharge / plan / admin grant). */
export async function creditWallet({
  companyId,
  amountPaise = 0,
  credits = 0,
  reason = "recharge",
  createdBy = null,
  meta = null,
}) {
  const company = await prisma.company.update({
    where: { id: companyId },
    data: {
      walletBalancePaise: { increment: amountPaise },
      messageCredits: { increment: credits },
    },
  });
  const txn = await prisma.walletTransaction.create({
    data: {
      companyId,
      type: "credit",
      reason,
      amountPaise,
      creditsDelta: credits,
      balanceAfter: company.walletBalancePaise,
      creditsAfter: company.messageCredits,
      createdBy,
      meta: meta || undefined,
    },
  });
  return { company, txn };
}

/** Meta conversation categories that bill the client wallet. Service/session is free. */
export function isPaidWhatsAppCategory(category) {
  const c = String(category || "").toUpperCase();
  if (!c) return true;
  if (c.includes("SERVICE") || c.includes("SESSION")) return false;
  return c.includes("MARKET") || c.includes("UTIL") || c.includes("AUTH");
}

export async function templateChargeCredits(companyId, templateName, extraMeta = {}) {
  if (!templateName) return { charged: false, creditsNeeded: 0 };
  const tpl = await prisma.template.findFirst({
    where: { name: templateName, ...(companyId ? { companyId } : {}) },
  });
  const category = tpl?.category || "Utility";
  if (!isPaidWhatsAppCategory(category)) {
    return { charged: false, creditsNeeded: 0, category };
  }
  const pricing = await getPlatformPricing();
  const creditsNeeded = pricing.creditPerOutbound || 1;
  await spendCredits(companyId, creditsNeeded, "message_send", {
    template: templateName,
    category,
    ...extraMeta,
  });
  return { charged: true, creditsNeeded, category };
}

export async function spendCredits(companyId, creditsNeeded = 1, reason = "message_send", meta = null) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw Object.assign(new Error("Company not found"), { status: 404 });
  if (company.freeAccess) {
    // Free access from Super Admin — no deduction, but log usage as 0-cost
    return { company, skipped: true };
  }
  const updated = await prisma.$transaction(async (tx) => {
    const debit = await tx.company.updateMany({
      where: { id: companyId, messageCredits: { gte: creditsNeeded } },
      data: { messageCredits: { decrement: creditsNeeded } },
    });
    if (!debit.count) {
      const err = new Error("Insufficient message credits. Please recharge your wallet.");
      err.status = 402;
      err.code = "NO_CREDITS";
      throw err;
    }
    const next = await tx.company.findUnique({ where: { id: companyId } });
    await tx.walletTransaction.create({
      data: {
        companyId,
        type: "debit",
        reason,
        amountPaise: 0,
        creditsDelta: -creditsNeeded,
        balanceAfter: next.walletBalancePaise,
        creditsAfter: next.messageCredits,
        meta: meta || undefined,
      },
    });
    return next;
  });
  return { company: updated, skipped: false };
}

/** Refund credits when outbound send fails after debit reservation. */
export async function refundCredits(companyId, credits = 1, reason = "message_refund", meta = null) {
  const company = await prisma.company.update({
    where: { id: companyId },
    data: { messageCredits: { increment: credits } },
  });
  await prisma.walletTransaction.create({
    data: {
      companyId,
      type: "credit",
      reason,
      amountPaise: 0,
      creditsDelta: credits,
      balanceAfter: company.walletBalancePaise,
      creditsAfter: company.messageCredits,
      meta: meta || undefined,
    },
  });
  return company;
}

export async function applyPlanCredits(companyId, planKey, createdBy = null) {
  const pricing = await getPlatformPricing();
  const map = {
    trial: pricing.trialCredits,
    starter: pricing.starterCredits,
    growth: pricing.growthCredits,
  };
  const credits = map[planKey] || 0;
  if (!credits) return null;
  return creditWallet({
    companyId,
    amountPaise: 0,
    credits,
    reason: planKey === "trial" ? "admin_grant" : "plan",
    createdBy,
    meta: { planKey },
  });
}
