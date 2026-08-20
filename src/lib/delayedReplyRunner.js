// lib/delayedReplyRunner.js — send delayed auto-replies when agents don't respond in time
import { prisma } from "./prisma.js";
import { sendText, getEffectiveCreds, assertLiveCreds } from "./whatsappService.js";

export async function runDelayedReplies() {
  try {
    const settings = await prisma.setting.findMany({
    where: { delayedEnabled: true },
    select: {
      companyId: true,
      delayedMinutes: true,
      delayedMessage: true,
    },
  });
  if (!settings.length) return;

  for (const s of settings) {
    const thresholdMs = Math.max(1, s.delayedMinutes || 15) * 60 * 1000;
    const cutoff = new Date(Date.now() - thresholdMs);

    const contacts = await prisma.contact.findMany({
      where: {
        companyId: s.companyId,
        chatStatus: { in: ["open", "pending"] },
      },
      take: 200,
    });

    for (const contact of contacts) {
      const attrs = contact.attributes || {};
      if (attrs.delayed_reply_sent_at) continue;

      const lastIn = await prisma.message.findFirst({
        where: { contactId: contact.id, direction: "in" },
        orderBy: { at: "desc" },
      });
      if (!lastIn || lastIn.at > cutoff) continue;

      const replyAfter = await prisma.message.findFirst({
        where: {
          contactId: contact.id,
          direction: "out",
          senderUserId: { not: null },
          at: { gt: lastIn.at },
        },
      });
      if (replyAfter) continue;

      try {
        const creds = await getEffectiveCreds(s.companyId);
        assertLiveCreds(creds);
        const r = await sendText(contact.phone, s.delayedMessage, creds);
        await prisma.message.create({
          data: {
            companyId: s.companyId,
            contactId: contact.id,
            waId: r.messages?.[0]?.id || null,
            direction: "out",
            type: "text",
            text: s.delayedMessage,
            status: "sent",
            automationSource: "delayed",
          },
        });
        await prisma.contact.update({
          where: { id: contact.id },
          data: {
            attributes: { ...attrs, delayed_reply_sent_at: new Date().toISOString() },
          },
        });
        console.log("[delayed-reply] sent to", contact.phone);
      } catch (e) {
        console.error("[delayed-reply]", contact.phone, e.message);
      }
    }
  }
  } catch (e) {
    console.error("[delayed-reply] runner failed:", e.message);
  }
}
