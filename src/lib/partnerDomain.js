/** Custom-domain helpers for partner white-label (CORS + branding). */

const TTL_MS = 60 * 1000;
const BLOCKED_HOSTS = new Set([
  "nexwapi.com",
  "www.nexwapi.com",
  "app.nexwapi.com",
  "api.nexwapi.com",
  "localhost",
  "127.0.0.1",
]);

let cache = { hosts: new Set(), expiresAt: 0 };

export function isExplicitTrue(v) {
  return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
}

export function normalizeHost(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (s.startsWith("www.")) s = s.slice(4);
  if (!s || BLOCKED_HOSTS.has(s) || BLOCKED_HOSTS.has(`www.${s}`)) return null;
  if (s.includes(" ") || s.includes("/") || s.includes("@")) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  if (s.endsWith(".nexwapi.com")) return null;
  return s;
}

export function normalizeWebsiteUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProto);
    if (!["http:", "https:"].includes(u.protocol) || !u.hostname) return "";
    return u.toString().slice(0, 300);
  } catch {
    return "";
  }
}

export function originHostname(origin) {
  try {
    return new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function bumpPartnerCorsCache() {
  cache.expiresAt = 0;
}

export async function refreshPartnerHosts(prisma) {
  const rows = await prisma.partner.findMany({
    where: { status: "ACTIVE", NOT: { customDomain: null } },
    select: { customDomain: true },
  });
  const hosts = new Set();
  for (const r of rows) {
    const h = normalizeHost(r.customDomain);
    if (h) {
      hosts.add(h);
      hosts.add(`www.${h}`);
    }
  }
  cache = { hosts, expiresAt: Date.now() + TTL_MS };
  return hosts;
}

export async function isPartnerCorsOrigin(origin) {
  const host = originHostname(origin);
  if (!host) return false;
  if (Date.now() > cache.expiresAt) {
    try {
      const { prisma } = await import("./prisma.js");
      await refreshPartnerHosts(prisma);
    } catch {
      /* keep stale cache */
    }
  }
  return cache.hosts.has(host) || cache.hosts.has(host.replace(/^www\./, ""));
}

export async function assertUniqueCustomDomain(prisma, host, exceptPartnerId) {
  if (!host) return;
  const clash = await prisma.partner.findFirst({
    where: {
      customDomain: host,
      ...(exceptPartnerId ? { id: { not: exceptPartnerId } } : {}),
    },
    select: { id: true },
  });
  if (clash) {
    const err = new Error("This domain is already used by another partner");
    err.status = 409;
    throw err;
  }
}

export function publicUploadUrl(req, storedPath) {
  const base = String(process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host") || "localhost"}`).replace(/\/$/, "");
  return `${base}/uploads/${storedPath.replace(/^\/+/, "")}`;
}
