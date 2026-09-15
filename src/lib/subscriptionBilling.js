// lib/subscriptionBilling.js — plan amount, enterprise seats, monthly wallet renewals
import { prisma } from "./prisma.js";
import {
  PLAN_CATALOG,
  PAID_PLAN_KEYS,
  PROFESSIONAL_SEAT_CAP,
  EXTRA_SEAT_PAISE,
  ENTERPRISE_MIN_SEATS,
  BILLING_PERIOD_MS,
  normalizePlan,
  isPaidPlan,
  normalizeEnterpriseSeats,
  enterpriseAmountPaise,
} from "./plans.js";
import { applyPlanCredits, debitWallet } from "./wallet.js";

export async function planBaseAmountPaise(planKey) {
  const key = normalizePlan(planKey);
  if (key === "enterprise") {
    // Enterprise base is Professional list price (extras added per seat).
    const row = await prisma.plan.findUnique({ where: { key: "professional" } }).catch(() => null);
    if (row && typeof row.amount === "number") return Math.max(0, row.amount);
    return PLAN_CATALOG.professional.amount;
  }
  const row = await prisma.plan.findUnique({ where: { key } }).catch(() => null);
  if (row && typeof row.amount === "number") return Math.max(0, row.amount);
  return Math.max(0, PLAN_CATALOG[key]?.amount || 0);
}

export function quoteEnterprise(seats, professionalBasePaise) {
  const purchasedSeats = normalizeEnterpriseSeats(seats);
  const amountPaise = enterpriseAmountPaise(purchasedSeats, professionalBasePaise);
  const extraSeats = Math.max(0, purchasedSeats - PROFESSIONAL_SEAT_CAP);
  return {
    purchasedSeats,
    extraSeats,
    amountPaise,
    amountLabel: `₹${Math.round(amountPaise / 100).toLocaleString("en-IN")}/mo`,
    breakdown: `Professional ₹${Math.round((professionalBasePaise || PLAN_CATALOG.professional.amount) / 100).toLocaleString("en-IN")} + ${extraSeats}×₹500`,
    professionalSeatCap: PROFESSIONAL_SEAT_CAP,
    extraSeatPaise: EXTRA_SEAT_PAISE,
    minSeats: ENTERPRISE_MIN_SEATS,
  };
}

export async function enterpriseExtraSeats(companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const seats = Math.max(0, Math.floor(Number(company?.purchasedSeats) || 0));
  return Math.max(0, seats - PROFESSIONAL_SEAT_CAP);
}

/** Monthly subscription charge in paise. */
export async function subscriptionMonthlyPaise(companyId, planKey) {
  const plan = normalizePlan(planKey);
  if (plan !== "enterprise") return planBaseAmountPaise(plan);
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const proBase = await planBaseAmountPaise("professional");
  const seats = Math.floor(Number(company?.purchasedSeats) || 0) || ENTERPRISE_MIN_SEATS;
  return enterpriseAmountPaise(seats, proBase);
}

export function nextBillingExpiry(from = new Date()) {
  return new Date(from.getTime() + BILLING_PERIOD_MS);
}

/** Set Enterprise purchased seats + subscription.amount (Professional + extras × ₹500). */
export async function setEnterpriseSeats(companyId, seats, { activate = true } = {}) {
  const proBase = await planBaseAmountPaise("professional");
  const quote = quoteEnterprise(seats, proBase);
  const company = await prisma.company.update({
    where: { id: companyId },
    data: {
      purchasedSeats: quote.purchasedSeats,
      ...(activate
        ? { plan: "enterprise", status: "ACTIVE", upgradedAt: new Date(), trialEndsAt: null }
        : {}),
    },
  });
  const now = new Date();
  const sub = await prisma.subscription.upsert({
    where: { companyId },
    update: {
      plan: "enterprise",
      status: "active",
      amount: quote.amountPaise,
      autoRenew: true,
      activatedAt: now,
      expiresAt: nextBillingExpiry(now),
      trialEndsAt: null,
    },
    create: {
      companyId,
      plan: "enterprise",
      status: "active",
      amount: quote.amountPaise,
      autoRenew: true,
      activatedAt: now,
      expiresAt: nextBillingExpiry(now),
    },
  });
  return { company, subscription: sub, quote };
}

export async function refreshEnterpriseSubscriptionAmount(companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company || normalizePlan(company.plan) !== "enterprise") return null;
  const seats = Math.floor(Number(company.purchasedSeats) || 0) || ENTERPRISE_MIN_SEATS;
  return setEnterpriseSeats(companyId, seats, { activate: true });
}

export async function activatePaidSubscription(companyId, planKey, { autoRenew = true, seats = null } = {}) {
  const plan = normalizePlan(planKey);
  const now = new Date();

  if (plan === "enterprise") {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    const seatCount =
      seats != null
        ? seats
        : Math.floor(Number(company?.purchasedSeats) || 0) || ENTERPRISE_MIN_SEATS;
    return setEnterpriseSeats(companyId, seatCount, { activate: true });
  }

  const amount = await planBaseAmountPaise(plan);
  await prisma.company.update({
    where: { id: companyId },
    data: { purchasedSeats: 0 },
  }).catch(() => {});

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
      console.warn(`[subscriptionRenewal] company=${company.id} failed:`, e?.message || e);
    }
  }

  if (renewed || failed) {
    console.log(`[subscriptionRenewal] renewed=${renewed} failed=${failed}`);
  }
  return { renewed, failed, checked: due.length };
}
