/**
 * WhatsApp Cloud API Calling — enable the in-chat Call button, permission,
 * Graph call actions, and webhook signaling for browser WebRTC.
 */
import { WA } from "../config/whatsapp.js";
import { prisma, pickColor } from "./prisma.js";
import { digitsOnly, findCompanyContactByPhone } from "./phone.js";
import { notify } from "./notify.js";
import { pushCallSignal } from "./callBus.js";

function graphVersion() {
  return process.env.WHATSAPP_API_VERSION || WA.version || "v22.0";
}

export function callingEligibleFromLimit(tier) {
  const t = String(tier || "").toUpperCase().replace(/\s+/g, "_");
  if (!t || t === "—" || t === "UNKNOWN") return false;
  if (t.includes("UNLIMITED") || t.includes("100K") || t.includes("10K")) return true;
  if (t.includes("TIER_2K") || t.includes("2000") || t.includes("2K")) return true;
  const n = parseInt(t.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) && n >= 2000;
}

export async function getCallingSettings(phoneNumberId, accessToken) {
  const res = await fetch(
    `https://graph.facebook.com/${graphVersion()}/${phoneNumberId}/settings`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok || data?.error) {
    const err = new Error(data?.error?.message || "Could not read WhatsApp calling settings");
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function setCallingEnabled(phoneNumberId, accessToken, enabled) {
  const body = {
    calling: {
      status: enabled ? "ENABLED" : "DISABLED",
      call_icon_visibility: enabled ? "DEFAULT" : "DISABLE_ALL",
      callback_permission_status: enabled ? "ENABLED" : "DISABLED",
    },
  };
  const res = await fetch(
    `https://graph.facebook.com/${graphVersion()}/${phoneNumberId}/settings`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json();
  if (!res.ok || data?.error) {
    const err = new Error(data?.error?.message || "Could not update WhatsApp calling settings");
    err.status = res.status;
    err.meta = data?.error || null;
    throw err;
  }
  return data;
}

export async function rejectWhatsAppCall(phoneNumberId, accessToken, callId) {
  const res = await fetch(
    `https://graph.facebook.com/${graphVersion()}/${phoneNumberId}/calls`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        call_id: callId,
        action: "reject",
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    console.warn("[wa calling] reject failed", data?.error?.message || res.status);
    return { ok: false, error: data?.error?.message };
  }
  return { ok: true, data };
}

/** Subscribe the Nexwapi app webhook to the `calls` field (plus existing message fields). */
export async function ensureCallsWebhookSubscription() {
  const appId = process.env.WHATSAPP_APP_ID || WA.appId;
  const appSecret = process.env.WHATSAPP_APP_SECRET || WA.appSecret;
  const callback = `${process.env.PUBLIC_API_URL || ""}/api/whatsapp/webhook`;
  const verify = process.env.WHATSAPP_VERIFY_TOKEN || WA.verifyToken;
  if (!appId || !appSecret || !callback.startsWith("http") || !verify) {
    return { ok: false, skipped: true, reason: "App credentials or PUBLIC_API_URL missing" };
  }
  const token = `${appId}|${appSecret}`;
  const res = await fetch(`https://graph.facebook.com/${graphVersion()}/${appId}/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      object: "whatsapp_business_account",
      callback_url: callback,
      verify_token: verify,
      fields: "messages,message_template_status_update,calls,account_update",
      access_token: token,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    console.warn("[wa calling] webhook subscribe", data?.error?.message || res.status);
    return { ok: false, error: data?.error?.message || String(res.status) };
  }
  return { ok: true, data };
}

function callingFromSettings(settings) {
  const calling = settings?.calling || settings;
  const status = String(calling?.status || "").toUpperCase();
  const icon = String(calling?.call_icon_visibility || "").toUpperCase();
  return {
    enabled: status === "ENABLED",
    iconVisible: icon !== "DISABLE_ALL",
    callbackPermission: String(calling?.callback_permission_status || "").toUpperCase() === "ENABLED",
    sipEnabled: String(calling?.sip?.status || "").toUpperCase() === "ENABLED",
    voicemail: calling?.voicemail || null,
    raw: calling || null,
  };
}

export async function callingStatusForAccount(wa) {
  const connected = Boolean(wa?.isConnected && wa.phoneNumberId && wa.accessToken);
  const messagingLimit = wa?.messagingLimit || null;
  const eligible = callingEligibleFromLimit(messagingLimit);
  let settings = null;
  let settingsError = null;
  if (connected) {
    try {
      const raw = await getCallingSettings(wa.phoneNumberId, wa.accessToken);
      settings = callingFromSettings(raw);
    } catch (e) {
      settingsError = e.message;
    }
  }
  return {
    connected,
    phoneNumber: wa?.displayPhoneNumber || wa?.phoneNumber || null,
    phoneNumberId: wa?.phoneNumberId || null,
    messagingLimit,
    eligible,
    callingEnabled: Boolean(settings?.enabled),
    callIconVisible: Boolean(settings?.iconVisible),
    sipEnabled: Boolean(settings?.sipEnabled),
    settingsError,
    settings,
    blockers: [
      !connected && "Connect WhatsApp (Dashboard → WhatsApp) with Facebook first.",
      connected && !eligible && "Meta allows WhatsApp Calling only after a messaging limit of 2,000 unique customers per day (usually TIER_10K). Send more utility templates to raise the limit.",
      connected && eligible && settingsError && `Meta calling settings: ${settingsError}`,
    ].filter(Boolean),
  };
}

export async function waAccountForCompany(companyId) {
  if (!companyId) return null;
  return (
    (await prisma.whatsAppAccount.findFirst({
      where: { companyId, isConnected: true },
      orderBy: { isDefault: "desc" },
    })) || prisma.whatsAppAccount.findFirst({ where: { companyId } })
  );
}

function throwCallError(data, status) {
  const err = data?.error || {};
  const code = err.code;
  const details = err.error_user_msg || err.error_data?.details || err.message || "WhatsApp call failed";
  const hints = {
    138006: "This customer has not allowed WhatsApp calls yet. Send a permission request first.",
    131047: "24-hour window closed. Wait for the customer to message you, then request call permission.",
  };
  const e = new Error(hints[code] ? `${code}: ${hints[code]}` : code ? `${code}: ${details}` : String(details));
  e.status = status >= 400 ? status : 502;
  e.meta = err;
  throw e;
}

export async function graphCall(phoneNumberId, accessToken, body) {
  const res = await fetch(`https://graph.facebook.com/${graphVersion()}/${phoneNumberId}/calls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throwCallError(data, res.status);
  return data;
}

export async function getCallPermission(phoneNumberId, accessToken, userWaId) {
  const url = `https://graph.facebook.com/${graphVersion()}/${phoneNumberId}/call_permissions?user_wa_id=${encodeURIComponent(userWaId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throwCallError(data, res.status);
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const start = actions.find((a) => a.action_name === "start_call");
  const request = actions.find((a) => a.action_name === "send_call_permission_request");
  const status = String(data.permission?.status || data.status || "").toLowerCase();
  const granted = ["temporary", "granted", "permanent"].includes(status);
  return {
    raw: data,
    status: status || "unknown",
    expiration: data.permission?.expiration_time || data.expiration_time || null,
    canStartCall: start ? Boolean(start.can_perform_action) : granted,
    canRequestPermission: request ? Boolean(request.can_perform_action) : !granted,
  };
}

function userPhoneFromCall(call, value) {
  const direction = String(call.direction || "").toUpperCase();
  const from = digitsOnly(call.from || call.caller || "");
  const to = digitsOnly(call.to || "");
  const biz = digitsOnly(value?.metadata?.display_phone_number || "");
  if (direction === "BUSINESS_INITIATED") return to || from;
  if (biz && from && from.slice(-10) === biz.slice(-10)) return to || from;
  return from || to;
}

async function ensureCallContact(companyId, phone) {
  if (!phone) return null;
  let contact = await findCompanyContactByPhone(prisma, companyId, phone);
  if (contact) return contact;
  const count = await prisma.contact.count({ where: { companyId } });
  return prisma.contact.create({
    data: {
      companyId,
      name: `+${phone}`,
      phone,
      tags: ["inbound", "whatsapp-call"],
      color: pickColor(count),
    },
  });
}

export async function logCallMessage({ companyId, contactId, callId, event, text, direction = "in" }) {
  if (!companyId || !contactId) return;
  await prisma.message.create({
    data: {
      companyId,
      waId: callId ? `call:${callId}:${event || "event"}` : null,
      contactId,
      direction,
      type: "call",
      text,
      status: direction === "in" ? "delivered" : "sent",
      at: new Date(),
    },
  }).catch((e) => {
    if (e?.code !== "P2002") console.warn("[wa calling] message", e.message);
  });
}

export async function handleCallingWebhook(value, companyId) {
  const calls = value?.calls || [];
  if (!calls.length || !companyId) return;

  for (const call of calls) {
    const event = String(call.event || call.status || "").toLowerCase();
    const callId = call.id || call.call_id;
    const direction = String(call.direction || "").toUpperCase() || "USER_INITIATED";
    const phone = userPhoneFromCall(call, value);
    const session = call.session || value.session || {};
    const sdp = session.sdp || null;
    const sdpType = session.sdp_type || session.sdpType || null;
    console.log("[wa calling]", event, direction, "user", phone, "id", callId, sdp ? "sdp" : "no-sdp");

    const contact = phone ? await ensureCallContact(companyId, phone) : null;

    pushCallSignal(companyId, {
      kind: "call",
      event,
      direction,
      callId,
      phone,
      contactId: contact?.id || null,
      name: contact?.name || (phone ? `+${phone}` : "WhatsApp"),
      sdp,
      sdpType,
    });

    if (!contact) continue;

    const inbound = direction !== "BUSINESS_INITIATED";
    const label =
      event === "connect" && inbound
        ? "Incoming WhatsApp call"
        : event === "connect"
          ? "WhatsApp call ringing"
          : event === "terminate" || event === "completed"
            ? "WhatsApp call ended"
            : `WhatsApp call (${event || "update"})`;

    await logCallMessage({
      companyId,
      contactId: contact.id,
      callId,
      event,
      text: label,
      direction: inbound ? "in" : "out",
    });

    if ((event === "connect" || event === "ringing") && inbound) {
      notify({
        audience: "client",
        companyId,
        title: `Incoming WhatsApp call from ${contact.name}`,
        body: `+${phone} is calling. Open Inbox and tap Answer.`,
        href: "/dashboard/inbox",
      }).catch(() => {});
    }
  }
}
