// src/lib/cashfree.js — Cashfree payment gateway integration
import crypto from "crypto";

const APP_ID = process.env.CASHFREE_APP_ID;
const SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const ENV = (process.env.CASHFREE_ENV || "PRODUCTION").toUpperCase(); // SANDBOX or PRODUCTION

export const CASHFREE_ENABLED = Boolean(APP_ID && SECRET_KEY);

const BASE_URL =
  ENV === "SANDBOX"
    ? "https://sandbox.cashfree.com/pg"
    : "https://api.cashfree.com/pg";

const API_VERSION = "2023-08-01";

// Plan catalog — amount in paise (INR × 100)
export const PLAN_CATALOG = {
  starter:      { name: "Starter",      amount: 89900,  currency: "INR", key: "starter" },
  growth:       { name: "Growth",       amount: 199900, currency: "INR", key: "growth" },
  professional: { name: "Professional", amount: 499900, currency: "INR", key: "professional" },
  pro:          { name: "Growth",       amount: 199900, currency: "INR", key: "growth" },
};

function headers() {
  return {
    "x-client-id": APP_ID,
    "x-client-secret": SECRET_KEY,
    "x-api-version": API_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Create a Cashfree payment session/order.
 * Returns { orderId, paymentSessionId, amount, currency }
 */
export async function createOrder({ orderId, amount, currency = "INR", customerPhone, customerEmail, customerName }) {
  if (!CASHFREE_ENABLED) throw new Error("Cashfree keys not configured");

  const body = {
    order_id: orderId,
    order_amount: amount / 100, // Cashfree takes rupees, not paise
    order_currency: currency,
    customer_details: {
      customer_id: `cust_${orderId}`,
      customer_phone: String(customerPhone || "9999999999"),
      customer_email: customerEmail || "customer@nexwapi.com",
      customer_name: customerName || "Customer",
    },
    order_meta: {
      return_url: `${process.env.APP_URL || "https://nexwapi.com"}/dashboard/upgrade?order_id={order_id}`,
      notify_url: `${process.env.PUBLIC_API_URL || "https://api.nexwapi.com"}/api/billing/webhook`,
    },
  };

  const res = await fetch(`${BASE_URL}/orders`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data?.message) {
    throw new Error(data?.message || `Cashfree order creation failed (${res.status})`);
  }
  return {
    orderId: data.order_id,
    paymentSessionId: data.payment_session_id,
    cfOrderId: data.cf_order_id,
    amount,
    currency,
  };
}

/**
 * Fetch order status from Cashfree to verify payment.
 * Returns the raw Cashfree order object.
 */
export async function fetchOrder(orderId) {
  if (!CASHFREE_ENABLED) throw new Error("Cashfree keys not configured");
  const res = await fetch(`${BASE_URL}/orders/${orderId}`, {
    method: "GET",
    headers: headers(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Cashfree fetch failed (${res.status})`);
  return data;
}

/**
 * Fetch payment list for an order.
 */
export async function fetchOrderPayments(orderId) {
  if (!CASHFREE_ENABLED) throw new Error("Cashfree keys not configured");
  const res = await fetch(`${BASE_URL}/orders/${orderId}/payments`, {
    method: "GET",
    headers: headers(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Cashfree payments fetch failed (${res.status})`);
  return Array.isArray(data) ? data : [];
}

/**
 * Verify Cashfree webhook signature.
 * Cashfree sends: x-webhook-signature (base64 HMAC-SHA256 of timestamp+rawBody)
 * and x-webhook-timestamp in headers.
 */
export function verifyWebhook(rawBody, signature, timestamp) {
  if (!SECRET_KEY || !signature || !timestamp) return false;
  try {
    const message = `${timestamp}${rawBody}`;
    const expected = crypto.createHmac("sha256", SECRET_KEY).update(message).digest("base64");
    return expected === signature;
  } catch {
    return false;
  }
}

/**
 * Parse the Cashfree webhook event body.
 * Returns { type, orderId, cfPaymentId, status }
 */
export function parseWebhookEvent(rawBody) {
  try {
    const event = JSON.parse(rawBody.toString("utf8"));
    const type = event?.type; // e.g. "PAYMENT_SUCCESS_WEBHOOK", "PAYMENT_FAILED_WEBHOOK"
    const orderId = event?.data?.order?.order_id || null;
    const cfPaymentId = event?.data?.payment?.cf_payment_id || null;
    const paymentStatus = event?.data?.payment?.payment_status || null;
    return { type, orderId, cfPaymentId, paymentStatus, raw: event };
  } catch {
    return { type: null, orderId: null, cfPaymentId: null, paymentStatus: null, raw: null };
  }
}
