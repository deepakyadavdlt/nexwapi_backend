// Default chatbot + automation for a company after WhatsApp is connected.
import { prisma } from "./prisma.js";
import { getCompanyCreds, createTemplate } from "./whatsappService.js";

const HELLO_BODY = "Hi {{1}}, thanks for connecting. How can we help you today?";

export async function ensureStarterMessaging(companyId) {
  if (!companyId) return { ok: false };
  const created = { flow: false, automation: false, template: false };

  const flowCount = await prisma.flow.count({ where: { companyId } });
  if (flowCount === 0) {
    await prisma.flow.create({
      data: {
        companyId,
        name: "Welcome chatbot",
        triggerType: "keyword",
        trigger: "hi",
        enabled: true,
        steps: [
          {
            id: "start",
            message: "Hi! 👋 Welcome. How can we help?",
            buttons: [
              { title: "Pricing", next: "pricing" },
              { title: "Talk to team", next: "agent" },
            ],
          },
          { id: "pricing", message: "Tell us what you need and our team will share plans.", buttons: [] },
          { id: "agent", message: "Thanks — a teammate will reply here in Inbox shortly.", buttons: [] },
        ],
      },
    });
    created.flow = true;
  }

  const autoCount = await prisma.automation.count({ where: { companyId } });
  if (autoCount === 0) {
    await prisma.automation.create({
      data: {
        companyId,
        name: "Price keyword",
        keyword: "price",
        matchType: "contains",
        reply: "Our plans start at ₹899/month for 2 team users. Reply HI to open the menu.",
        enabled: true,
      },
    });
    created.automation = true;
  }

  const tplCount = await prisma.template.count({ where: { companyId } });
  if (tplCount === 0) {
    const creds = await getCompanyCreds(companyId);
    let status = "pending";
    let metaError = null;
    if (creds && !creds.incomplete && creds.wabaId) {
      try {
        const r = await createTemplate(
          {
            name: "hello_offer",
            category: "UTILITY",
            language: "en_US",
            body: HELLO_BODY,
          },
          creds
        );
        status = String(r.status || "PENDING").toLowerCase();
      } catch (e) {
        metaError = e.message;
        console.warn("[starter] template submit:", e.message);
      }
    }
    await prisma.template.upsert({
      where: { companyId_name: { companyId, name: "hello_offer" } },
      create: {
        companyId,
        name: "hello_offer",
        category: "Utility",
        language: "en_US",
        body: HELLO_BODY,
        status: metaError ? "pending" : status,
      },
      update: {},
    }).catch(() => {});
    created.template = true;
  }

  return { ok: true, created };
}
