// lib/intentMatcher.js — fuzzy intent routing to automations & flows

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function scoreOverlap(messageWords, target) {
  const targetWords = tokenize(target);
  if (!targetWords.length || !messageWords.length) return 0;
  let hits = 0;
  for (const w of targetWords) {
    if (messageWords.some((m) => m === w || m.includes(w) || w.includes(m))) hits++;
  }
  return hits / targetWords.length;
}

/** Build trigger catalog from automations + flows */
export function buildTriggerCatalog(automations, flows) {
  const items = [];
  for (const a of automations) {
    if (!a.enabled) continue;
    const keywords = a.matchType === "any"
      ? [a.name, a.reply?.slice(0, 80)].filter(Boolean)
      : String(a.keyword || "").split(",").map((k) => k.trim()).filter(Boolean);
    if (!keywords.length) continue;
    items.push({ type: "automation", id: a.id, name: a.name, keywords, payload: a });
  }
  for (const f of flows) {
    if (!f.enabled) continue;
    const keywords = f.triggerType === "any"
      ? [f.name]
      : String(f.trigger || "").split(",").map((k) => k.trim()).filter(Boolean);
    if (!keywords.length && f.triggerType !== "any") continue;
    items.push({ type: "flow", id: f.id, name: f.name, keywords: keywords.length ? keywords : [f.name], payload: f });
  }
  return items;
}

/** Returns best match { type, id, score, payload } or null */
export function matchIntent(message, catalog, { minScore = 0.35 } = {}) {
  const words = tokenize(message);
  if (!words.length || !catalog.length) return null;
  let best = null;
  for (const item of catalog) {
    let score = 0;
    for (const kw of item.keywords) {
      score = Math.max(score, scoreOverlap(words, kw));
    }
    if (item.keywords.some((k) => String(message).toLowerCase().includes(k.toLowerCase()))) {
      score = Math.max(score, 0.8);
    }
    if (score >= minScore && (!best || score > best.score)) {
      best = { type: item.type, id: item.id, score, payload: item.payload, name: item.name };
    }
  }
  return best;
}
