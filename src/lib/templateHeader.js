import { prisma } from "./prisma.js";

function isUnknownHeaderFieldError(e) {
  const msg = String(e?.message || "");
  return msg.includes("Unknown argument") && (msg.includes("headerImageUrl") || msg.includes("headerFormat"));
}

/** Read header media fields even when Prisma client is stale (raw SQL). */
export async function getTemplateHeaderMedia(companyId, templateName) {
  if (!companyId || !templateName) return { headerImageUrl: null, headerFormat: null };
  try {
    const rows = await prisma.$queryRaw`
      SELECT "headerImageUrl", "headerFormat"
      FROM "Template"
      WHERE "companyId" = ${companyId}
        AND "name" = ${String(templateName)}
        AND "deletedAt" IS NULL
      LIMIT 1
    `;
    const row = rows?.[0];
    return {
      headerImageUrl: row?.headerImageUrl || null,
      headerFormat: row?.headerFormat || null,
    };
  } catch {
    return { headerImageUrl: null, headerFormat: null };
  }
}

/** Attach headerImageUrl/headerFormat from DB when Prisma client is stale. */
export async function enrichTemplatesWithHeaders(templates) {
  if (!templates?.length) return templates || [];
  try {
    const ids = templates.map((t) => t.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "id", "headerImageUrl", "headerFormat" FROM "Template" WHERE "id" IN (${placeholders})`,
      ...ids
    );
    const map = new Map((rows || []).map((r) => [r.id, r]));
    return templates.map((t) => {
      const h = map.get(t.id);
      if (!h) return t;
      return { ...t, headerImageUrl: h.headerImageUrl, headerFormat: h.headerFormat };
    });
  } catch {
    return templates;
  }
}

export async function patchTemplateHeaderMedia(templateId, { headerImageUrl, headerFormat } = {}) {
  if (!templateId) return;
  const url = headerImageUrl === undefined ? undefined : (String(headerImageUrl || "").trim() || null);
  const fmt = headerFormat === undefined ? undefined : (String(headerFormat || "").trim() || null);
  if (url === undefined && fmt === undefined) return;

  const data = {};
  if (url !== undefined) data.headerImageUrl = url;
  if (fmt !== undefined) data.headerFormat = fmt;

  try {
    await prisma.template.update({ where: { id: templateId }, data });
  } catch (e) {
    if (!isUnknownHeaderFieldError(e)) throw e;
    try {
      if (url !== undefined && fmt !== undefined) {
        await prisma.$executeRaw`
          UPDATE "Template"
          SET "headerImageUrl" = ${url}, "headerFormat" = ${fmt}
          WHERE "id" = ${templateId}
        `;
      } else if (url !== undefined) {
        await prisma.$executeRaw`
          UPDATE "Template" SET "headerImageUrl" = ${url} WHERE "id" = ${templateId}
        `;
      } else if (fmt !== undefined) {
        await prisma.$executeRaw`
          UPDATE "Template" SET "headerFormat" = ${fmt} WHERE "id" = ${templateId}
        `;
      }
    } catch (sqlErr) {
      console.warn("[templateHeader] header patch skipped:", sqlErr?.message || sqlErr);
    }
  }
}
