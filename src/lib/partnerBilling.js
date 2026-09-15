/**
 * Attach client WABAs to Nexwapi's Meta extended credit line so clients
 * never add card/currency — Nexwapi pays Meta conversation fees.
 */
import { WA } from "../config/whatsapp.js";
import { prisma } from "./prisma.js";

const VERSION = process.env.WHATSAPP_API_VERSION || WA.version || "v22.0";

export function partnerBillingConfig() {
  const creditLineId =
    process.env.META_CREDIT_LINE_ID ||
    process.env.WHATSAPP_CREDIT_LINE_ID ||
    null;
  const partnerToken =
    process.env.WHATSAPP_SYSTEM_USER_TOKEN ||
    process.env.WHATSAPP_ACCESS_TOKEN ||
    null;
  const partnerBusinessId =
    process.env.META_PARTNER_BUSINESS_ID ||
    process.env.WHATSAPP_BUSINESS_ID ||
    null;
  const currency = String(process.env.WHATSAPP_BILLING_CURRENCY || "INR").toUpperCase();
  return { creditLineId, partnerToken, partnerBusinessId, currency };
}

export function partnerBillingReady() {
  const { creditLineId, partnerToken } = partnerBillingConfig();
  return Boolean(creditLineId && partnerToken);
}

async function graphJson(url, { method = "GET", token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data, status: res.status };
}

/** Read WABA currency from Meta (empty = billing not ready). */
export async function fetchWabaBilling(wabaId, accessToken) {
  if (!wabaId || !accessToken) return { currency: null, timezone: null };
  const { ok, data } = await graphJson(
    `https://graph.facebook.com/${VERSION}/${wabaId}?fields=id,name,currency,timezone_id`,
    { token: accessToken }
  );
  if (!ok) return { currency: null, timezone: null, error: data?.error?.message };
  return {
    currency: data.currency || null,
    timezone: data.timezone_id || null,
    name: data.name || null,
  };
}

/** Discover first extended credit line on partner business. */
export async function discoverCreditLineId(businessId, token) {
  if (!businessId || !token) return null;
  const { ok, data } = await graphJson(
    `https://graph.facebook.com/${VERSION}/${businessId}/extendedcredits?fields=id,legal_entity_name`,
    { token }
  );
  if (!ok) return null;
  return data?.data?.[0]?.id || null;
}

/**
 * Attach a client WABA to Nexwapi credit line (Meta partner billing).
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/manage-accounts/share-and-revoke-credit-lines
 */
export async function attachWabaToPartnerCreditLine(wabaId, currency) {
  const cfg = partnerBillingConfig();
  const wabaCurrency = String(currency || cfg.currency || "INR").toUpperCase();
  if (!wabaId) return { ok: false, skipped: true, reason: "no_waba" };

  let creditLineId = cfg.creditLineId;
  const token = cfg.partnerToken;
  if (!token) {
    return { ok: false, skipped: true, reason: "no_partner_token" };
  }

  if (!creditLineId && cfg.partnerBusinessId) {
    creditLineId = await discoverCreditLineId(cfg.partnerBusinessId, token);
  }
  if (!creditLineId) {
    return { ok: false, skipped: true, reason: "no_credit_line_id" };
  }

  const { ok, data } = await graphJson(
    `https://graph.facebook.com/${VERSION}/${creditLineId}/whatsapp_credit_sharing_and_attach`,
    {
      method: "POST",
      token,
      body: { waba_id: String(wabaId), waba_currency: wabaCurrency },
    }
  );

  if (ok) {
    return { ok: true, creditLineId, currency: wabaCurrency, data };
  }

  const msg = String(data?.error?.message || "attach failed");
  // Already attached — treat as success
  if (/already|attached|shared/i.test(msg)) {
    return { ok: true, creditLineId, currency: wabaCurrency, already: true };
  }
  return { ok: false, error: msg, creditLineId, meta: data?.error };
}

/**
 * Ensure client WABA bills to Nexwapi. Attach credit line if needed, verify currency.
 */
export async function ensureWabaPartnerBilling(wabaId, { accessToken, currency } = {}) {
  const cfg = partnerBillingConfig();
  const token = accessToken || cfg.partnerToken;

  const before = await fetchWabaBilling(wabaId, token);
  if (before.currency) {
    return { ok: true, currency: before.currency, attached: false, ready: true };
  }

  const attach = await attachWabaToPartnerCreditLine(wabaId, currency);
  if (!attach.ok && !attach.skipped) {
    return { ok: false, ready: false, error: attach.error, attach };
  }
  if (attach.skipped) {
    return { ok: false, ready: false, skipped: true, reason: attach.reason };
  }

  // Meta can take a moment to reflect currency
  await new Promise((r) => setTimeout(r, 1500));
  const after = await fetchWabaBilling(wabaId, token);
  return {
    ok: Boolean(after.currency),
    ready: Boolean(after.currency),
    currency: after.currency,
    attached: true,
    attach,
    before,
    after,
  };
}

/** Attach partner billing and persist status on WhatsAppAccount. */
export async function applyPartnerBillingToAccount(wa) {
  if (!wa?.wabaId) return { ok: false, skipped: true, reason: "no_waba" };

  const result = await ensureWabaPartnerBilling(wa.wabaId, { accessToken: wa.accessToken });
  const patch = {
    billingCurrency: result.currency || null,
    partnerBillingAt: result.ready ? new Date() : wa.partnerBillingAt || null,
    lastError: null,
  };

  if (!result.ready && !result.skipped) {
    patch.lastError = `billing: ${result.error || result.reason || "not ready"}`;
  }

  if (wa.id) {
    try {
      await prisma.whatsAppAccount.update({ where: { id: wa.id }, data: patch });
    } catch (e) {
      console.warn("[partnerBilling] account update:", e?.message || e);
    }
  }

  return result;
}
