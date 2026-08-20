// lib/flowRunner.js — workflow follow-ups and idle timeout
import { prisma } from "./prisma.js";
import { sendText, getEffectiveCreds, assertLiveCreds } from "./whatsappService.js";

export async function runFlowMaintenance() {
  try {
    const settings = await prisma.setting.findMany({
    where: { OR: [{ flowFollowUpEnabled: true }, { flowIdleTimeoutMinutes: { gt: 0 } }] },
  });

  for (const s of settings) {
    const companyId = s.companyId;
    const contacts = await prisma.contact.findMany({
      where: { companyId, activeFlowId: { not: null } },
      take: 100,
    });

    for (const contact of contacts) {
      const lastIn = await prisma.message.findFirst({
        where: { contactId: contact.id, direction: "in" },
        orderBy: { at: "desc" },
      });
      const lastOut = await prisma.message.findFirst({
        where: { contactId: contact.id, direction: "out" },
        orderBy: { at: "desc" },
      });

      // Idle timeout — deactivate bot if user silent too long
      const idleMs = Math.max(5, s.flowIdleTimeoutMinutes || 60) * 60 * 1000;
      const lastActivity = lastIn?.at || contact.updatedAt;
      if (lastActivity && Date.now() - lastActivity.getTime() > idleMs) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { activeFlowId: null, activeFlowStep: null },
        });
        console.log("[flow] idle timeout cleared for", contact.phone);
        continue;
      }

      // Follow-up if bot waiting and user hasn't replied
      if (!s.flowFollowUpEnabled || !s.flowFollowUpMessage?.trim()) continue;
      const attrs = contact.attributes || {};
      if (attrs.flow_followup_sent_at) continue;
      if (!lastOut || (lastIn && lastIn.at > lastOut.at)) continue;

      const followMs = Math.max(5, s.flowFollowUpMinutes || 30) * 60 * 1000;
      if (Date.now() - lastOut.at.getTime() < followMs) continue;

      try {
        const creds = await getEffectiveCreds(companyId);
        assertLiveCreds(creds);
        const r = await sendText(contact.phone, s.flowFollowUpMessage, creds);
        await prisma.message.create({
          data: {
            companyId,
            contactId: contact.id,
            waId: r.messages?.[0]?.id || null,
            direction: "out",
            type: "text",
            text: s.flowFollowUpMessage,
            status: "sent",
            automationSource: "workflow",
          },
        });
        await prisma.contact.update({
          where: { id: contact.id },
          data: { attributes: { ...attrs, flow_followup_sent_at: new Date().toISOString() } },
        });
        console.log("[flow] follow-up sent to", contact.phone);
      } catch (e) {
        console.error("[flow] follow-up failed:", e.message);
      }
    }
  }
  } catch (e) {
    console.error("[flow] maintenance failed:", e.message);
  }
}
