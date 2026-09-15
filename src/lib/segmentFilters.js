// lib/segmentFilters.js — shared segment filter logic for contacts queries

/** Build a Prisma WHERE clause for contacts from a segment's filters JSON */
export function buildSegmentContactWhere(seg, companyId) {
  const base = { companyId };
  if (seg.whatsappOnly !== false) base.optedIn = { not: false };
  const filters = seg.filters;
  if (!filters) {
    if (seg.tags && seg.tags.length > 0) {
      base.tags = seg.match === "all" ? { hasEvery: seg.tags } : { hasSome: seg.tags };
    }
    return base;
  }
  const { type, conditions = [], match: filterMatch = "any" } = filters;
  if (type === "tags" && conditions.length > 0) {
    const isNot = conditions.some((c) => c.operator === "is_not");
    const tagValues = conditions.map((c) => c.value).filter(Boolean);
    if (tagValues.length > 0) {
      if (isNot) {
        // Exclude contacts that have any of these tags
        base.NOT = { tags: filterMatch === "all" ? { hasEvery: tagValues } : { hasSome: tagValues } };
      } else {
        base.tags = filterMatch === "all" ? { hasEvery: tagValues } : { hasSome: tagValues };
      }
    }
  } else if (type === "fields" && conditions.length > 0) {
    const clauses = conditions.map((c) => buildFieldClause(c)).filter(Boolean);
    if (clauses.length > 0) {
      if (filterMatch === "all") {
        base.AND = clauses;
      } else {
        base.OR = clauses;
      }
    }
  }
  return base;
}

function buildFieldClause(c) {
  const { field, operator, value } = c;
  if (!field) return null;
  if (field === "name") {
    if (operator === "contains") return { name: { contains: value, mode: "insensitive" } };
    if (operator === "starts_with") return { name: { startsWith: value, mode: "insensitive" } };
    return { name: value };
  }
  if (field === "phone") return operator === "equals" ? { phone: value } : { phone: { contains: value } };
  if (field === "email") {
    if (operator === "contains") return { email: { contains: value, mode: "insensitive" } };
    return { email: value };
  }
  if (field === "userId") return operator === "contains" ? { userId: { contains: value } } : { userId: value };
  if (field === "optedIn" || field === "whatsappOpted") return { optedIn: value === "true" || value === true };
  if (field === "createdAt") {
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return operator === "before" ? { createdAt: { lt: d } } : { createdAt: { gt: d } };
  }
  if (field === "tags") return { tags: { has: value } };
  return { attributes: { path: [field], equals: value } };
}
