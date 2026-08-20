// lib/aiAgent.js — knowledge-based AI replies for WhatsApp
import { prisma } from "./prisma.js";
import { sendText, getEffectiveCreds, assertLiveCreds } from "./whatsappService.js";

function tokenize(text) {
  return String(text || "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
}

function chunksFromText(title, text, size = 400) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out = [];
  for (let i = 0; i < clean.length; i += size) {
    out.push({ title, content: clean.slice(i, i + size) });
  }
  return out;
}

export function getKnowledgeChunks(setting) {
  const raw = Array.isArray(setting?.aiAgentKnowledge) ? setting.aiAgentKnowledge : [];
  const chunks = [];
  for (const item of raw) {
    if (item.content) chunks.push(...chunksFromText(item.title || "Knowledge", item.content));
  }
  return chunks;
}

function bestChunk(query, chunks) {
  const qWords = tokenize(query);
  if (!qWords.length || !chunks.length) return null;
  let best = null;
  for (const c of chunks) {
    const cWords = tokenize(c.content);
    let hits = 0;
    for (const w of qWords) {
      if (cWords.includes(w)) hits++;
    }
    const score = hits / qWords.length;
    if (!best || score > best.score) best = { ...c, score };
  }
  return best?.score > 0.15 ? best : chunks[0] || null;
}

export function composeAgentReply(query, setting) {
  const chunks = getKnowledgeChunks(setting);
  const chunk = bestChunk(query, chunks);
  const greeting = setting.aiAgentGreeting?.trim();
  if (!chunk) {
    return greeting || "Thanks for your message! A team member will assist you shortly.";
  }
  const excerpt = chunk.content.length > 280 ? `${chunk.content.slice(0, 277)}…` : chunk.content;
  return `${excerpt}\n\n— Nexwapi Assistant`;
}

export async function syncWebsiteKnowledge(companyId, url) {
  if (!url?.trim()) throw new Error("Website URL required");
  const res = await fetch(url.trim(), { headers: { "User-Agent": "NexwapiBot/1.0" } });
  if (!res.ok) throw new Error(`Could not fetch website (${res.status})`);
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
  if (!text) throw new Error("No readable text found on website");
  const setting = await prisma.setting.findUnique({ where: { companyId } });
  const existing = Array.isArray(setting?.aiAgentKnowledge) ? setting.aiAgentKnowledge : [];
  const filtered = existing.filter((k) => k.source !== "website");
  const knowledge = [...filtered, { title: "Website", source: "website", url: url.trim(), content: text }];
  await prisma.setting.upsert({
    where: { companyId },
    update: { aiAgentWebsiteUrl: url.trim(), aiAgentKnowledge: knowledge },
    create: { companyId, aiAgentWebsiteUrl: url.trim(), aiAgentKnowledge: knowledge },
  });
  return { chars: text.length };
}

export async function maybeAiAgentReply(contact, message, companyId) {
  const s = await prisma.setting.findUnique({ where: { companyId } }).catch(() => null);
  if (!s?.aiAgentEnabled) return false;
  const reply = composeAgentReply(message, s);
  try {
    const creds = await getEffectiveCreds(companyId);
    assertLiveCreds(creds);
    const r = await sendText(contact.phone, reply, creds);
    await prisma.message.create({
      data: {
        companyId,
        contactId: contact.id,
        waId: r.messages?.[0]?.id || null,
        direction: "out",
        type: "text",
        text: reply,
        status: "sent",
      },
    });
    console.log("[ai-agent] replied to", contact.phone);
    return true;
  } catch (e) {
    console.error("[ai-agent]", e.message);
    return false;
  }
}
