export function digitsOnly(phone) {
  return String(phone || "").replace(/\D/g, "");
}

export function last10(phone) {
  return digitsOnly(phone).slice(-10);
}

export function looksLikePhone(value) {
  const s = String(value || "").trim();
  const d = digitsOnly(s);
  return d.length >= 8 && /^\+?[\d\s-]{6,}$/.test(s);
}

export async function findCompanyContactByPhone(prisma, companyId, phone) {
  const d = digitsOnly(phone);
  const l10 = d.slice(-10);
  if (!l10) return null;
  const candidates = [d, l10, d.length === 10 ? `91${d}` : null, l10.length === 10 ? `91${l10}` : null].filter(Boolean);
  const unique = [...new Set(candidates)];
  return prisma.contact.findFirst({
    where: { companyId, phone: { in: unique } },
  });
}
