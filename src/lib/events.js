// lib/events.js — outgoing webhooks + contact activity logging.
import { prisma } from "./prisma.js";

// Record an activity event on a contact's timeline (best-effort).
export function logActivity(contactId, type, text) {
  if (!contactId) return;
  prisma.event.create({ data: { contactId, type, text } }).catch(() => {});
}

/**
 * POST customer message / delivery events to the company's configured webhook URL.
 * @param {string} companyId
 * @param {string} event
 * @param {object} data
 */
export async function fireEvent(companyId, event, data = {}) {
  if (!companyId) return;
  try {
    const s = await prisma.setting.findUnique({ where: { companyId } });
    const url = String(s?.webhookUrl || "").trim();
    if (!url) return;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Nexwapi-Webhook/1.0",
          "X-Nexwapi-Event": String(event),
        },
        body: JSON.stringify({
          event,
          data,
          companyId,
          at: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn("[events] webhook non-OK", res.status, url);
      } else {
        console.log("[events] fired", event, "->", url);
      }
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    console.error("[events] webhook failed:", e.message);
  }
}

/** Fire a test payload so the customer can verify their endpoint. */
export async function fireTestWebhook(companyId) {
  await fireEvent(companyId, "webhook.test", {
    message: "Nexwapi test webhook — your endpoint is configured correctly.",
  });
  return { ok: true };
}
