/** Default Nexwapi chrome vs partner white-label branding. */
export const NEXWAPI_BRAND = {
  productName: "Nexwapi",
  logoUrl: null,
  primaryColor: "#0f8a3c",
  hideNexwapi: false,
  slug: null,
  partnerId: null,
  websiteUrl: "",
  customDomain: "",
};

export function partnerBranding(partner) {
  if (!partner) return { ...NEXWAPI_BRAND };
  const customName = String(partner.productName || "").trim();
  const productName = customName || String(partner.name || "").trim() || "Nexwapi";
  const hideNexwapi = Boolean(customName || partner.logoUrl);
  return {
    productName,
    logoUrl: partner.logoUrl || null,
    primaryColor: partner.primaryColor || "#0f8a3c",
    hideNexwapi,
    slug: partner.slug || null,
    partnerId: partner.id || null,
    websiteUrl: partner.websiteUrl || "",
    customDomain: partner.customDomain || "",
  };
}

export async function resolvePartnerByHost(prisma, { slug, host } = {}) {
  const s = String(slug || "").trim().toLowerCase();
  if (s) {
    return prisma.partner.findFirst({ where: { slug: s, status: "ACTIVE" } });
  }
  const { normalizeHost } = await import("./partnerDomain.js");
  const raw = String(host || "").trim().toLowerCase().replace(/:\d+$/, "");
  const h = normalizeHost(raw) || raw.replace(/^www\./, "");
  if (!h || h === "localhost" || h === "127.0.0.1") return null;
  const byDomain = await prisma.partner.findFirst({
    where: {
      status: "ACTIVE",
      OR: [{ customDomain: h }, { customDomain: `www.${h}` }, { customDomain: raw }],
    },
  });
  if (byDomain) return byDomain;
  const parts = raw.split(".");
  if (parts.length >= 3 && (raw.endsWith(".nexwapi.com") || raw.endsWith(".localhost"))) {
    const sub = parts[0];
    if (sub && sub !== "app" && sub !== "www" && sub !== "api") {
      return prisma.partner.findFirst({ where: { slug: sub, status: "ACTIVE" } });
    }
  }
  return null;
}

export async function resolveClientMailBrand({ email, partnerSlug, partner } = {}) {
  if (partner && partner.status !== "SUSPENDED") {
    const { publicPartnerBranding } = await import("./tenant.js");
    return publicPartnerBranding(partner);
  }
  try {
    const { prisma } = await import("./prisma.js");
    const { publicPartnerBranding } = await import("./tenant.js");
    const slug = String(partnerSlug || "").trim().toLowerCase();
    if (slug) {
      const row = await prisma.partner.findFirst({ where: { slug, status: "ACTIVE" } });
      if (row) return publicPartnerBranding(row);
    }
    const em = String(email || "").toLowerCase().trim();
    if (!em) return null;
    const user = await prisma.user.findUnique({
      where: { email: em },
      include: { company: { include: { partner: true } } },
    });
    if (!user || user.role === "SUPER_ADMIN" || user.role === "PARTNER") return null;
    const row = user.company?.partner;
    if (row?.status === "ACTIVE") return publicPartnerBranding(row);
  } catch {
    return null;
  }
  return null;
}
