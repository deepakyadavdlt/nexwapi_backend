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

/** Admin debit — never goes below zero. Rejects if the client does not have enough. */
export async function debitWallet({
  companyId,
  amountPaise = 0,
  credits = 0,
  reason = "admin_debit",
  createdBy = null,
  meta = null,
}) {
  const paise = Math.max(0, Math.floor(Number(amountPaise) || 0));
  const cr = Math.max(0, Math.floor(Number(credits) || 0));
  if (!paise && !cr) {
    throw Object.assign(new Error("credits or amountPaise required"), { status: 400 });
  }

  return prisma.$transaction(async (tx) => {
    const company = await tx.company.findUnique({ where: { id: companyId } });
    if (!company) throw Object.assign(new Error("Company not found"), { status: 404 });

    if (cr) {
      const debitCr = await tx.company.updateMany({
        where: { id: companyId, messageCredits: { gte: cr } },
        data: { messageCredits: { decrement: cr } },
      });
      if (!debitCr.count) {
        throw Object.assign(new Error(`Insufficient credits. Client has ${company.messageCredits}.`), {
          status: 400,
          code: "INSUFFICIENT_CREDITS",
          available: company.messageCredits,
        });
      }
    }
    if (paise) {
      const debitPaise = await tx.company.updateMany({
        where: { id: companyId, walletBalancePaise: { gte: paise } },
        data: { walletBalancePaise: { decrement: paise } },
      });
      if (!debitPaise.count) {
        throw Object.assign(new Error("Insufficient wallet balance."), {
          status: 400,
          code: "INSUFFICIENT_WALLET",
          available: company.walletBalancePaise,
        });
      }
    }

    const updated = await tx.company.findUnique({ where: { id: companyId } });
    const txn = await tx.walletTransaction.create({
      data: {
        companyId,
        type: "debit",
        reason,
        amountPaise: paise ? -paise : 0,
        creditsDelta: cr ? -cr : 0,
        balanceAfter: updated.walletBalancePaise,
        creditsAfter: updated.messageCredits,
        createdBy,
        meta: meta || undefined,
      },
    });
    return { company: updated, txn };
  });
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
    return { company, skipped: true };
  }
  const needed = Math.max(1, Math.floor(Number(creditsNeeded) || 1));
  const pricing = await getPlatformPricing();
  const cpr = Math.max(1, Number(pricing.creditsPerRupee) || 10);
  const paisePerCredit = Math.max(1, Math.round(100 / cpr));
  const paiseNeeded = needed * paisePerCredit;

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.company.findUnique({ where: { id: companyId } });
    if (!current) throw Object.assign(new Error("Company not found"), { status: 404 });
    const paiseDebit = Math.min(paiseNeeded, Math.max(0, current.walletBalancePaise || 0));
    const debit = await tx.company.updateMany({
      where: { id: companyId, messageCredits: { gte: needed } },
      data: {
        messageCredits: { decrement: needed },
        ...(paiseDebit > 0 ? { walletBalancePaise: { decrement: paiseDebit } } : {}),
      },
    });
    if (!debit.count) {
      const err = new Error("Insufficient message credits. Please recharge your wallet or subscribe to a plan.");
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
        amountPaise: paiseDebit ? -paiseDebit : 0,
        creditsDelta: -needed,
        balanceAfter: next.walletBalancePaise,
        creditsAfter: next.messageCredits,
        meta: meta || undefined,
      },
    });
    return next;
  });
  return { company: updated, skipped: false, creditsNeeded: needed };
}

/** Charge platform credits for a session text/media outbound (inbox / API text). */
export async function chargeSessionOutbound(companyId, extraMeta = {}) {
  const pricing = await getPlatformPricing();
  const creditsNeeded = pricing.creditPerOutbound || 1;
  const r = await spendCredits(companyId, creditsNeeded, "message_send", {
    channel: "session",
    ...extraMeta,
  });
  return { charged: !r.skipped, creditsNeeded: r.skipped ? 0 : creditsNeeded };
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

/** Plan allotment for a key (platform settings). */
export async function planCreditAllotment(planKey) {
  const pricing = await getPlatformPricing();
  const map = {
    trial: pricing.trialCredits,
    starter: pricing.starterCredits,
    growth: pricing.growthCredits,
    professional: pricing.growthCredits,
    enterprise: pricing.growthCredits,
  };
  return Math.max(0, Math.floor(Number(map[planKey]) || 0));
}

/**
 * Set message credits to the plan allotment (replace, do not stack on switch).
 * Wallet rupees are unchanged — only messageCredits are reset to the plan pack.
 */
export async function applyPlanCredits(companyId, planKey, createdBy = null) {
  const target = await planCreditAllotment(planKey);
  if (!target && planKey !== "expired") return null;

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return null;

  const before = Math.max(0, Number(company.messageCredits) || 0);
  const delta = target - before;
  if (delta === 0) return { company, skipped: true };

  const updated = await prisma.company.update({
    where: { id: companyId },
    data: { messageCredits: target },
  });
  await prisma.walletTransaction.create({
    data: {
      companyId,
      type: delta > 0 ? "credit" : "debit",
      reason: planKey === "trial" ? "admin_grant" : "plan",
      amountPaise: 0,
      creditsDelta: delta,
      balanceAfter: updated.walletBalancePaise,
      creditsAfter: updated.messageCredits,
      createdBy,
      meta: { planKey, mode: "set", before, target },
    },
  });
  return { company: updated, txn: true };
}
