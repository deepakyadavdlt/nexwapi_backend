// lib/events.js — fire outgoing webhook events to a configured URL (Zapier/Make/custom).
import { prisma } from "./prisma.js";

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
