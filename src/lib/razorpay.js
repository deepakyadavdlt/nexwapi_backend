// src/lib/razorpay.js — Razorpay client + signature verification.
import Razorpay from "razorpay";
import crypto from "crypto";

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

// True once both keys are present in the environment.
export const RAZORPAY_ENABLED = Boolean(KEY_ID && KEY_SECRET);
export const RAZORPAY_KEY_ID = KEY_ID || null;

// Plans a client can buy. amount is in paise (₹499 = 49900).
export const PLANS = {
  pro: { name: "Pro", amount: 49900, currency: "INR" },
};

let instance = null;
export function razorpay() {
  if (!RAZORPAY_ENABLED) throw new Error("Razorpay keys not configured");
  if (!instance) instance = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
  return instance;
}

// Verify the checkout callback signature (HMAC-SHA256 of "orderId|paymentId").
export function verifySignature(orderId, paymentId, signature) {
  if (!KEY_SECRET) return false;
  const expected = crypto.createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
  return expected === signature;
}

// Server-to-server webhook secret (set when creating the webhook in Razorpay).
export const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

// Verify a webhook: HMAC-SHA256 of the RAW request body using the webhook secret.
export function verifyWebhook(rawBody, signature) {
  if (!WEBHOOK_SECRET || !signature) return false;
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  return expected === signature;
}
