import { prisma } from "./prisma.js";

export const DEFAULT_TAGS = [
  { name: "Repeat Buyers", color: "#0f8a3c" },
  { name: "Recovered", color: "#22a344" },
  { name: "Order Placed(Prepaid)", color: "#3ad35a" },
  { name: "Order Placed(COD)", color: "#6ee7a0" },
  { name: "Abandoned Cart", color: "#F59E0B" },
  { name: "New Lead", color: "#34B7F1" },
  { name: "VIP", color: "#7C3AED" },
  { name: "Opted Out", color: "#EF4444" },
];

const DEFAULT_MAX_CUSTOM = 15;

export function serializeTag(t) {
  return {
    id: t.id,
    name: t.name,
    color: t.color || "#25D366",
    isDefault: Boolean(t.isDefault),
    type: t.isDefault ? "Default" : "Custom",
    createdBy: t.createdBy || "",
    deletedAt: t.deletedAt ? t.deletedAt.getTime() : null,
    createdAt: t.createdAt instanceof Date ? t.createdAt.getTime() : t.createdAt,
  };
}

export async function ensureDefaultTags(companyId) {
  const count = await prisma.tag.count({ where: { companyId } });
  if (count > 0) return;
  for (const d of DEFAULT_TAGS) {
    await prisma.tag.create({
      data: {
        companyId,
        name: d.name,
        color: d.color,
        isDefault: true,
        createdBy: "System",
      },
    }).catch(() => {});
  }
}

export async function getTagLimit(companyId) {
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: {},
    create: { companyId, businessName: "Nexwapi" },
  });
  return Number(s.maxCustomTags) > 0 ? Number(s.maxCustomTags) : DEFAULT_MAX_CUSTOM;
}

export async function listTags(companyId, { q, deleted = false } = {}) {
  await ensureDefaultTags(companyId);
  const where = {
    companyId,
    deletedAt: deleted ? { not: null } : null,
    ...(q
      ? { name: { contains: String(q).trim(), mode: "insensitive" } }
      : {}),
  };
  const rows = await prisma.tag.findMany({
    where,
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
  return rows.map(serializeTag);
}

export async function tagsMeta(companyId) {
  await ensureDefaultTags(companyId);
  const [totalActive, customActive, maxCustom] = await Promise.all([
    prisma.tag.count({ where: { companyId, deletedAt: null } }),
    prisma.tag.count({ where: { companyId, deletedAt: null, isDefault: false } }),
    getTagLimit(companyId),
  ]);
  return {
    totalTags: totalActive,
    totalCustomTags: customActive,
    maxCustomTags: maxCustom,
    customRemaining: Math.max(0, maxCustom - customActive),
  };
}

export async function createTag(companyId, { name, color, createdBy } = {}) {
  const nm = String(name || "").trim();
  if (!nm) {
    const err = new Error("name required");
    err.status = 400;
    throw err;
  }
  const meta = await tagsMeta(companyId);
  if (meta.totalCustomTags >= meta.maxCustomTags) {
    const err = new Error(`Custom tag limit reached (${meta.maxCustomTags}). Upgrade to increase.`);
    err.status = 403;
    err.code = "TAG_LIMIT";
    throw err;
  }
  // Soft-deleted same name → restore as custom
  const soft = await prisma.tag.findFirst({
    where: { companyId, name: nm, deletedAt: { not: null } },
  });
  if (soft) {
    const restored = await prisma.tag.update({
      where: { id: soft.id },
      data: {
        deletedAt: null,
        isDefault: false,
        color: color || soft.color,
        createdBy: createdBy || soft.createdBy || "",
      },
    });
    return serializeTag(restored);
  }
  try {
    const t = await prisma.tag.create({
      data: {
        companyId,
        name: nm,
        color: color || "#25D366",
        isDefault: false,
        createdBy: String(createdBy || "").trim(),
      },
    });
    return serializeTag(t);
  } catch (e) {
    if (e.code === "P2002") {
      const err = new Error("Tag already exists");
      err.status = 409;
      throw err;
    }
    throw e;
  }
}

export async function softDeleteTags(companyId, ids) {
  const idList = Array.isArray(ids) ? ids.map(String) : [];
  if (!idList.length) {
    const err = new Error("ids required");
    err.status = 400;
    throw err;
  }
  const rows = await prisma.tag.findMany({
    where: { companyId, id: { in: idList }, deletedAt: null },
  });
  // Allow deleting defaults (soft) — Interakt shows delete on selection; we'll block hard defaults restore only
  const result = await prisma.tag.updateMany({
    where: { companyId, id: { in: rows.map((r) => r.id) } },
    data: { deletedAt: new Date() },
  });
  return { deleted: result.count };
}

export async function restoreTag(companyId, id) {
  const row = await prisma.tag.findFirst({ where: { id, companyId } });
  if (!row) {
    const err = new Error("Tag not found");
    err.status = 404;
    throw err;
  }
  if (!row.deletedAt) return serializeTag(row);
  if (!row.isDefault) {
    const meta = await tagsMeta(companyId);
    if (meta.totalCustomTags >= meta.maxCustomTags) {
      const err = new Error(`Custom tag limit reached (${meta.maxCustomTags}).`);
      err.status = 403;
      err.code = "TAG_LIMIT";
      throw err;
    }
  }
  const t = await prisma.tag.update({
    where: { id: row.id },
    data: { deletedAt: null },
  });
  return serializeTag(t);
}

export async function hardDeleteTag(companyId, id) {
  const row = await prisma.tag.findFirst({ where: { id, companyId } });
  if (!row) {
    const err = new Error("Tag not found");
    err.status = 404;
    throw err;
  }
  if (row.isDefault && !row.deletedAt) {
    const err = new Error("Default tags can only be soft-deleted");
    err.status = 400;
    throw err;
  }
  await prisma.tag.delete({ where: { id: row.id } });
  // Strip from contacts
  const contacts = await prisma.contact.findMany({
    where: { companyId, tags: { has: row.name } },
    select: { id: true, tags: true },
  });
  for (const c of contacts) {
    await prisma.contact.update({
      where: { id: c.id },
      data: { tags: (c.tags || []).filter((t) => t !== row.name) },
    }).catch(() => {});
  }
  return { ok: true };
}
