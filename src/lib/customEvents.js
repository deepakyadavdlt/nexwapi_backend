import { prisma } from "./prisma.js";
import { fireEvent } from "./events.js";

/** Built-in events shown on Events Settings (read-only). */
export const DEFAULT_EVENTS = [
  {
    name: "Phone Number Updated",
    traits: ["country_code", "phone_number"],
    info: "Tracked whenever a contact's phone number is updated.",
  },
  {
    name: "Flow Completed",
    traits: ["Campaign Id", "Flow Id", "Flow Token"],
    info: "Tracked whenever your customer fills & sends a form or completes a chatbot flow.",
  },
  {
    name: "CTWA Notification",
    traits: ["source_id", "source_url"],
    info: "Tracked whenever a customer starts a conversation from a Click-to-WhatsApp ad.",
  },
  {
    name: "Replied to Notification",
    traits: ["Reply Text", "Reply Date", "Campaign Name"],
    info: "Tracked whenever a campaign message is replied to by the customer.",
  },
  {
    name: "Notification Sent",
    traits: ["created_at_utc", "Campaign Name", "Date Sent", "Channel"],
    info: "Tracked whenever a campaign message is sent to a contact.",
  },
  {
    name: "Message Received",
    traits: ["from", "text", "type"],
    info: "Tracked whenever an inbound WhatsApp message is received.",
  },
  {
    name: "Message Sent",
    traits: ["to", "text", "template", "messageId"],
    info: "Tracked whenever an outbound message is sent via Inbox or API.",
  },
];

const DEFAULT_MAX = 2;

export function serializeCustomEvent(row) {
  return {
    id: row.id,
    name: row.name,
    traits: Array.isArray(row.traits) ? row.traits : [],
    description: row.description || "",
    createdBy: row.createdBy || "",
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : row.createdAt,
  };
}

export async function getMaxCustomEvents(companyId) {
  const s = await prisma.setting.upsert({
    where: { companyId },
    update: {},
    create: { companyId, businessName: "Nexwapi" },
  });
  return Number(s.maxCustomEvents) > 0 ? Number(s.maxCustomEvents) : DEFAULT_MAX;
}

export async function listEventsSettings(companyId) {
  const [custom, max] = await Promise.all([
    prisma.customEvent.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } }),
    getMaxCustomEvents(companyId),
  ]);
  return {
    defaultEvents: DEFAULT_EVENTS,
    customEvents: custom.map(serializeCustomEvent),
    used: custom.length,
    max,
  };
}

export async function createCustomEvent(companyId, { name, traits, description, createdBy } = {}) {
  const nm = String(name || "").trim();
  if (!nm) {
    const err = new Error("Event name required");
    err.status = 400;
    throw err;
  }
  const traitList = Array.isArray(traits)
    ? traits.map((t) => String(t).trim()).filter(Boolean)
    : String(traits || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

  const [count, max] = await Promise.all([
    prisma.customEvent.count({ where: { companyId } }),
    getMaxCustomEvents(companyId),
  ]);
  if (count >= max) {
    const err = new Error(`Custom event limit reached (${max}). Upgrade your plan to add more.`);
    err.status = 403;
    err.code = "EVENT_LIMIT";
    throw err;
  }

  try {
    const row = await prisma.customEvent.create({
      data: {
        companyId,
        name: nm,
        traits: traitList,
        description: String(description || "").trim(),
        createdBy: String(createdBy || "").trim(),
      },
    });
    return serializeCustomEvent(row);
  } catch (e) {
    if (e.code === "P2002") {
      const err = new Error("An event with this name already exists");
      err.status = 409;
      throw err;
    }
    throw e;
  }
}

export async function deleteCustomEvent(companyId, id) {
  const deleted = await prisma.customEvent.deleteMany({ where: { id, companyId } });
  if (!deleted.count) {
    const err = new Error("Event not found");
    err.status = 404;
    throw err;
  }
  return { ok: true };
}

/**
 * Track a custom (or registered) event for a contact via public Event API.
 */
export async function trackContactEvent(companyId, { event, phone, userId, traits = {} } = {}) {
  const eventName = String(event || "").trim();
  if (!eventName) {
    const err = new Error("event name required");
    err.status = 400;
    throw err;
  }

  const custom = await prisma.customEvent.findFirst({
    where: { companyId, name: { equals: eventName, mode: "insensitive" } },
  });
  const isDefault = DEFAULT_EVENTS.some((d) => d.name.toLowerCase() === eventName.toLowerCase());
  if (!custom && !isDefault) {
    const err = new Error(
      "Unknown event. Register it under Events Settings (Custom Events) or use a default event name."
    );
    err.status = 400;
    err.code = "UNKNOWN_EVENT";
    throw err;
  }

  const cleanPhone = String(phone || "").replace(/[^\d]/g, "");
  let contact = null;
  if (cleanPhone) {
    contact = await prisma.contact.findFirst({ where: { companyId, phone: cleanPhone } });
  }
  if (!contact && userId) {
    contact = await prisma.contact.findFirst({ where: { companyId, userId: String(userId) } });
  }
  if (!contact) {
    const err = new Error("Contact not found. Add the contact before tracking events.");
    err.status = 404;
    err.code = "CONTACT_NOT_FOUND";
    throw err;
  }

  const traitObj = traits && typeof traits === "object" ? traits : {};
  const summary = Object.keys(traitObj).length
    ? Object.entries(traitObj)
        .slice(0, 6)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "no traits";

  const { logActivity } = await import("./events.js");
  logActivity(contact.id, "event", `${eventName}: ${summary}`);

  fireEvent(companyId, "custom.event", {
    event: eventName,
    phone: contact.phone,
    contactId: contact.id,
    traits: traitObj,
  }).catch(() => {});

  return {
    ok: true,
    event: eventName,
    contactId: contact.id,
    phone: contact.phone,
  };
}
