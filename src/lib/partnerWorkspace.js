/** Partner agency gets its own Company workspace (full CRM) + managed client companies. */
import { prisma } from "./prisma.js";
import { getPlatformPricing } from "./wallet.js";
import { uniqueSlug } from "./tenant.js";

export function partnerWorkspaceSlug(partnerSlug) {
  const base = String(partnerSlug || "agency")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40) || "agency";
  return `${base}-workspace`;
}

export function isPartnerWorkspaceCompany(company, partner) {
  if (!company || !partner) return false;
  return company.slug === partnerWorkspaceSlug(partner.slug);
}

/**
 * Ensure the partner owner has a home Company for full CRM (inbox, wallet, templates…).
 * Client list excludes this workspace via partnerWhereClients().
 */
export async function ensurePartnerWorkspace(partner, ownerUser) {
  if (!partner?.id) return null;
  const slug = partnerWorkspaceSlug(partner.slug);

  let company = await prisma.company.findFirst({
    where: { partnerId: partner.id, slug },
  });

  if (!company && ownerUser?.companyId) {
    const owned = await prisma.company.findUnique({ where: { id: ownerUser.companyId } });
    if (owned && owned.partnerId === partner.id) company = owned;
  }

  if (!company) {
    const pricing = await getPlatformPricing();
    const credits = Number(pricing.growthCredits) || 20000;
    let finalSlug = slug;
    const clash = await prisma.company.findUnique({ where: { slug: finalSlug } }).catch(() => null);
    if (clash) finalSlug = await uniqueSlug(`${partner.name || partner.slug}-hq`);

    company = await prisma.company.create({
      data: {
        name: String(partner.productName || partner.name || "Agency").trim() || "Agency",
        slug: finalSlug,
        email: partner.email || ownerUser?.email || null,
        status: "ACTIVE",
        plan: "growth",
        trialEndsAt: null,
        trialStartedAt: null,
        messageCredits: credits,
        walletBalancePaise: 0,
        partnerId: partner.id,
        upgradedAt: new Date(),
      },
    });

    await prisma.subscription
      .create({
        data: {
          companyId: company.id,
          plan: "growth",
          status: "active",
          activatedAt: new Date(),
        },
      })
      .catch(() => {});

    await prisma.setting
      .create({
        data: {
          companyId: company.id,
          businessName: partner.productName || partner.name,
          autoAssign: true,
        },
      })
      .catch(() => {});

    await prisma.walletTransaction
      .create({
        data: {
          companyId: company.id,
          type: "credit",
          reason: "plan",
          amountPaise: 0,
          creditsDelta: credits,
          balanceAfter: 0,
          creditsAfter: credits,
          meta: { planKey: "growth", partnerWorkspace: true },
        },
      })
      .catch(() => {});
  }

  if (ownerUser?.id && ownerUser.companyId !== company.id) {
    await prisma.user.update({
      where: { id: ownerUser.id },
      data: { companyId: company.id },
    });
  }

  return company;
}

/** Prisma where: partner's sold clients only (not the agency's own CRM workspace). */
export function partnerClientWhere(partner) {
  return {
    partnerId: partner.id,
    NOT: { slug: partnerWorkspaceSlug(partner.slug) },
  };
}
