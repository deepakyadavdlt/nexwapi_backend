// lib/events.js — outgoing webhooks + contact activity logging.
import { prisma } from "./prisma.js";

// Record an activity event on a contact's timeline (best-effort).
export function logActivity(contactId, type, text) {
  if (!contactId) return;
  prisma.event.create({ data: { contactId, type, text } }).catch(() => {});
}

export async function fireEvent(event, data) {
  try {
    const s = await prisma.setting.findUnique({ where: { id: "default" } });
    if (!s?.webhookUrl) return;
    await fetch(s.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, data, at: new Date().toISOString() }),
    });
    console.log("[events] fired", event, "->", s.webhookUrl);
  } catch (e) {
    console.error("[events] webhook failed:", e.message);
  }
}
