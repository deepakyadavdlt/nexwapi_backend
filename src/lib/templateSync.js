/**
 * Keep local template rows in sync with Meta so campaigns can send
 * as soon as WhatsApp approves — no manual "Sync from Meta" required.
 */
import { patchTemplateHeaderMedia } from "./templateHeader.js";
import { prisma } from "./prisma.js";
import { listTemplates, getEffectiveCreds, wabaIdForSending, resolveTemplateHeaderMediaUrl } from "./whatsappService.js";

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

function headerFieldsFromMeta(mt) {
  const headerComp = (mt.components || []).find((c) => String(c.type).toUpperCase() === "HEADER");
  if (!headerComp) return {};
  const headerFormat = String(headerComp.format || "").toUpperCase() || null;
  const headerImageUrl = resolveTemplateHeaderMediaUrl(headerComp);
  return {
    ...(headerFormat ? { headerFormat } : {}),
    ...(headerImageUrl ? { headerImageUrl } : {}),
  };
}

export function normalizeTemplateStatus(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  if (s === "APPROVED" || s === "ACTIVE" || s === "REINSTATED") return "approved";
  if (s === "REJECTED" || s === "REJECTION") return "rejected";
  if (s === "PENDING" || s === "IN_REVIEW" || s === "RECEIVED" || s === "SUBMITTED") return "pending";
  if (s === "PAUSED") return "pending";
  if (s === "DELETED" || s === "PENDING_DELETION") return "deleted";
  return s.toLowerCase();
}

async function notifyOwner(companyId, name, status) {
  try {
    const owner = await prisma.user.findFirst({
      where: { companyId, role: { in: ["OWNER", "ADMIN"] } },
      orderBy: { createdAt: "asc" },
    });
    if (!owner?.email) return;
    const { sendTemplateStatus } = await import("./mailer.js");
    await sendTemplateStatus(owner.email, name, status);
  } catch (e) {
    console.warn("[templateSync mail]", e?.message || e);
  }
}

/** Resolve live Meta creds for template list/sync (WABA may be inferred from Phone ID). */
export async function templateSyncCreds(companyId) {
  if (!companyId) return null;
  const creds = await getEffectiveCreds(companyId);
  if (!creds || creds.incomplete || creds.platformFallback) return null;
  if (!creds.phoneNumberId || !creds.accessToken) return null;
  const wabaId = await wabaIdForSending(creds);
  if (!wabaId) {
    console.warn("[templateSync] could not resolve WABA for company", companyId);
    return null;
  }
  if (!creds.wabaId || creds.wabaId !== wabaId) {
    await prisma.whatsAppAccount.updateMany({
      where: { companyId, isConnected: true },
      data: { wabaId, lastSyncAt: new Date() },
    }).catch(() => {});
  }
  return { ...creds, wabaId };
}

/**
 * Apply a Meta message_template_status_update webhook to the local DB.
 */
export async function applyTemplateStatusUpdate({ companyId, name, language, event }) {
  const status = normalizeTemplateStatus(event);
  const tplName = String(name || "").trim();
  if (!tplName || !status) return null;
  if (!companyId) {
    console.warn("[templateSync] no company for template status", tplName);
    return null;
  }

  const where = {
    name: { equals: tplName, mode: "insensitive" },
    deletedAt: null,
    companyId,
  };
  const matches = await prisma.template.findMany({ where, orderBy: { createdAt: "desc" }, take: 8 });
  const lang = language ? String(language).toLowerCase().replace(/-/g, "_") : "";
  const tpl =
    (lang && matches.find((t) => String(t.language || "").toLowerCase().replace(/-/g, "_") === lang)) ||
    matches[0] ||
    null;
  if (!tpl) {
    console.warn("[templateSync] no local template for", tplName, companyId);
    return null;
  }
  const prev = tpl.status;
  const updated = await prisma.template.update({
    where: { id: tpl.id },
    data: {
      status,
      ...(language ? { language: String(language) } : {}),
    },
  });
  if (prev !== status && /approv|reject/i.test(status)) {
    notifyOwner(tpl.companyId, tpl.name, status).catch(() => {});
  }
  console.log("[templateSync] webhook", tpl.name, prev, "→", status);
  return updated;
}

/**
 * Pull Meta's live template list and reconcile this company's local rows.
 */
export async function syncCompanyTemplates(companyId) {
  if (!companyId) return [];
  const creds = await templateSyncCreds(companyId);
  if (!creds) {
    return prisma.template.findMany({
      where: { companyId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  let metaTemplates = [];
  try {
    metaTemplates = await listTemplates(creds);
  } catch (e) {
    console.warn("[templateSync] listTemplates", companyId, e?.message || e);
    return prisma.template.findMany({
      where: { companyId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  const localRows = await prisma.template.findMany({
    where: { companyId, deletedAt: null },
  });

  for (const mt of metaTemplates || []) {
    const status = normalizeTemplateStatus(mt.status);
    if (!mt.name || !status) continue;
    const existing =
      localRows.find((t) => t.name.toLowerCase() === String(mt.name).toLowerCase()) ||
      null;
    if (existing) {
      const prev = existing.status;
      const bodyComp = (mt.components || []).find((c) => String(c.type).toUpperCase() === "BODY");
      const body = bodyComp?.text || existing.body;
      const headerFields = headerFieldsFromMeta(mt);
      await prisma.template.update({
        where: { id: existing.id },
        data: {
          status,
          category: cap(mt.category) || existing.category,
          language: mt.language || existing.language,
          body,
        },
      });
      if (Object.keys(headerFields).length) {
        await patchTemplateHeaderMedia(existing.id, headerFields);
      }
      if (prev !== status && /approv|reject/i.test(status)) {
        notifyOwner(companyId, mt.name, status).catch(() => {});
      }
    } else {
      const bodyComp = (mt.components || []).find((c) => String(c.type).toUpperCase() === "BODY");
      const headerFields = headerFieldsFromMeta(mt);
      const created = await prisma.template.create({
        data: {
          companyId,
          name: mt.name,
          status,
          category: cap(mt.category) || "Utility",
          language: mt.language || "en",
          body: bodyComp?.text || "(synced from Meta)",
        },
      });
      if (Object.keys(headerFields).length) {
        await patchTemplateHeaderMedia(created.id, headerFields);
      }
    }
  }

  return prisma.template.findMany({
    where: { companyId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

/** Refresh one template from Meta (used before sending a campaign). */
export async function refreshTemplateFromMeta(companyId, name) {
  if (!companyId || !name) return null;
  await syncCompanyTemplates(companyId).catch((e) => {
    console.warn("[templateSync] refresh failed", e?.message || e);
  });
  return prisma.template.findFirst({
    where: {
      companyId,
      deletedAt: null,
      name: { equals: String(name), mode: "insensitive" },
    },
  });
}

const PENDING_STATUSES = ["pending", "PENDING", "in_review", "submitted", "received", "paused"];

/** Background: companies with pending templates get a Meta pull. */
export async function runPendingTemplateSyncs() {
  const pending = await prisma.template.findMany({
    where: { deletedAt: null, status: { in: PENDING_STATUSES } },
    select: { companyId: true },
    distinct: ["companyId"],
    take: 40,
  });
  for (const row of pending) {
    if (!row.companyId) continue;
    try {
      await syncCompanyTemplates(row.companyId);
    } catch (e) {
      console.warn("[templateSync] pending sync", row.companyId, e?.message || e);
    }
  }
}

/** Force Meta pull for every connected workspace (admin refresh). */
export async function syncAllConnectedTemplateStatuses() {
  const accounts = await prisma.whatsAppAccount.findMany({
    where: { isConnected: true, phoneNumberId: { not: null }, accessToken: { not: null } },
    select: { companyId: true },
    distinct: ["companyId"],
    take: 200,
  });
  let synced = 0;
  for (const row of accounts) {
    if (!row.companyId) continue;
    try {
      await syncCompanyTemplates(row.companyId);
      synced += 1;
    } catch (e) {
      console.warn("[templateSync] all sync", row.companyId, e?.message || e);
    }
  }
  return { companies: synced };
}
