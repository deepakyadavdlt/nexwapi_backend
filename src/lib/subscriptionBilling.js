// lib/subscriptionBilling.js — plan amount, enterprise seats, monthly wallet renewals
import { prisma } from "./prisma.js";
import {
  PLAN_CATALOG,
  PAID_PLAN_KEYS,
  EXTRA_SEAT_PAISE,
  ENTERPRISE_INCLUDED_SEATS,
  BILLING_PERIOD_MS,
  normalizePlan,
  isPaidPlan,
} from "./plans.js";
import { applyPlanCredits, debitWallet } from "./wallet.js";

export async function planBaseAmountPaise(planKey) {
  const key = normalizePlan(planKey);
  const row = await prisma.plan.findUnique({ where: { key } }).catch(() => null);
  if (row && typeof row.amount === "number") return Math.max(0, row.amount);
  return Math.max(0, PLAN_CATALOG[key]?.amount || 0);
}

export async function enterpriseExtraSeats(companyId) {
  const agents = await prisma.agent.count({ where: { companyId } });
  return Math.max(0, agents - ENTERPRISE_INCLUDED_SEATS);
}

/** Monthly subscription charge in paise (base plan + Enterprise per-user add-ons). */
export async function subscriptionMonthlyPaise(companyId, planKey) {
  const plan = normalizePlan(planKey);
  const base = await planBaseAmountPaise(plan);
  if (plan !== "enterprise") return base;
  const extra = await enterpriseExtraSeats(companyId);
  return base + extra * EXTRA_SEAT_PAISE;
}

export function nextBillingExpiry(from = new Date()) {
  return new Date(from.getTime() + BILLING_PERIOD_MS);
}

/**
 * Recalculate Enterprise subscription.amount = base + (extra seats × ₹500).
 * Safe to call after add/remove team users or plan switch.
 */
export async function refreshEnterpriseSubscriptionAmount(companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company || normalizePlan(company.plan) !== "enterprise") return null;

  const amount = await subscriptionMonthlyPaise(companyId, "enterprise");
  const extra = await enterpriseExtraSeats(companyId);
  return prisma.subscription.upsert({
    where: { companyId },
    update: { amount, plan: "enterprise", status: "active" },
    create: {
      companyId,
      plan: "enterprise",
      status: "active",
      amount,
      autoRenew: true,
      activatedAt: new Date(),
      expiresAt: nextBillingExpiry(),
    },
  }).then((sub) => ({ ...sub, extraSeats: extra }));
}

/**
 * Activate / refresh paid subscription period after purchase or admin plan assign.
 */
export async function activatePaidSubscription(companyId, planKey, { autoRenew = true } = {}) {
  const plan = normalizePlan(planKey);
  const amount = await subscriptionMonthlyPaise(companyId, plan);
  const now = new Date();
  return prisma.subscription.upsert({
    where: { companyId },
    update: {
      plan,
      status: "active",
      amount,
      autoRenew: Boolean(autoRenew),
      activatedAt: now,
      expiresAt: isPaidPlan(plan) ? nextBillingExpiry(now) : null,
      trialEndsAt: null,
    },
    create: {
      companyId,
      plan,
      status: "active",
      amount,
      autoRenew: Boolean(autoRenew),
      activatedAt: now,
      expiresAt: isPaidPlan(plan) ? nextBillingExpiry(now) : null,
    },
  });
}

/**
 * Monthly auto-cut: debit wallet for subscription.amount and extend expiresAt.
 * Insufficient wallet → past_due + company EXPIRED.
 */
export async function runSubscriptionRenewals() {
  const now = new Date();
  const due = await prisma.subscription.findMany({
    where: {
      autoRenew: true,
      status: { in: ["active", "past_due"] },
      plan: { in: PAID_PLAN_KEYS },
      OR: [
        { expiresAt: { lte: now } },
        { expiresAt: null, activatedAt: { lte: new Date(now.getTime() - BILLING_PERIOD_MS) } },
      ],
    },
    include: { company: true },
  });

  let renewed = 0;
  let failed = 0;

  for (const sub of due) {
    const company = sub.company;
    if (!company || company.freeAccess) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { expiresAt: nextBillingExpiry(now), status: "active" },
      }).catch(() => {});
      renewed += 1;
      continue;
    }
    if (company.status === "SUSPENDED") continue;

    const plan = normalizePlan(sub.plan || company.plan);
    if (!isPaidPlan(plan)) continue;

    const amount = await subscriptionMonthlyPaise(company.id, plan);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { amount, plan },
    }).catch(() => {});

    if (!amount) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { expiresAt: nextBillingExpiry(now), status: "active" },
      }).catch(() => {});
      renewed += 1;
      continue;
    }

    try {
      await debitWallet({
        companyId: company.id,
        amountPaise: amount,
        credits: 0,
        reason: "subscription_renewal",
        meta: { plan, subscriptionId: sub.id },
      });
      await applyPlanCredits(company.id, plan, null).catch(() => {});
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status: "active",
          expiresAt: nextBillingExpiry(now),
          amount,
          plan,
        },
      });
      await prisma.company.update({
        where: { id: company.id },
        data: { status: "ACTIVE", plan },
      }).catch(() => {});
      renewed += 1;
    } catch (e) {
      failed += 1;
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: "past_due" },
      }).catch(() => {});
      await prisma.company.update({
        where: { id: company.id },
        data: { status: "EXPIRED", plan: "expired" },
      }).catch(() => {});
      console.warn(
        `[subscriptionRenewal] company=${company.id} failed:`,
        e?.message || e
      );
    }
  }

  if (renewed || failed) {
    console.log(`[subscriptionRenewal] renewed=${renewed} failed=${failed}`);
  }
  return { renewed, failed, checked: due.length };
}
