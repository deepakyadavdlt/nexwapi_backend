// lib/apiKey.js — API key hashing + lookup (Razorpay-style key_id + secret)
import crypto from "crypto";
import { prisma } from "./prisma.js";

export function hashApiKey(rawKey) {
  return crypto.createHash("sha256").update(String(rawKey)).digest("hex");
}

export function hashSecret(rawSecret) {
  return `sha256:${hashApiKey(rawSecret)}`;
}

export function keyPrefix(rawKey) {
  const s = String(rawKey);
  if (s.length <= 16) return s;
  return `${s.slice(0, 12)}…${s.slice(-4)}`;
}

export function generateKeyId() {
  return `nex_live_${crypto.randomBytes(8).toString("hex")}`;
}

export function generateApiSecret() {
  return `nex_sk_live_${crypto.randomBytes(24).toString("hex")}`;
}

export function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString("hex")}`;
}

function matchesStoredSecret(stored, rawSecret) {
  if (!stored || !rawSecret) return false;
  const hashed = hashSecret(rawSecret);
  if (stored === hashed) return true;
  // Legacy plaintext or full nex_ key stored directly
  return stored === String(rawSecret);
}

/** Find API key by raw secret value; supports hashed + legacy plaintext rows. */
export async function findApiKeyByRaw(rawKey) {
  if (!rawKey) return null;
  const key = String(rawKey);
  const hashed = hashSecret(key);

  let row = await prisma.apiKey.findFirst({
    where: { key: hashed },
    include: { company: true },
  });
  if (row) return row;

  row = await prisma.apiKey.findFirst({
    where: { key },
    include: { company: true },
  });
  if (!row) return null;

  try {
    await prisma.apiKey.update({
      where: { id: row.id },
      data: { key: hashed },
    });
    row.key = hashed;
  } catch {
    // benign race on migration
  }
  return row;
}

/** Razorpay-style: key_id + key_secret */
export async function findApiKeyByIdAndSecret(keyId, secret) {
  if (!keyId || !secret) return null;
  const row = await prisma.apiKey.findFirst({
    where: { keyId: String(keyId) },
    include: { company: true },
  });
  if (!row || !matchesStoredSecret(row.key, secret)) return null;
  return row;
}

export function publicApiKeyRow(row) {
  const keyId = row.keyId || `nex_legacy_${String(row.id).slice(-8)}`;
  return {
    id: row.id,
    name: row.name,
    keyId,
    key: keyPrefix(keyId),
    secretMasked: "nex_sk_live_••••••••",
    createdAt: row.createdAt.getTime(),
    lastUsedAt: row.lastUsedAt?.getTime() || null,
  };
}

/** Backfill keyId for legacy rows (secret cannot be recovered — user must regenerate). */
export async function backfillApiKeyIds() {
  const rows = await prisma.apiKey.findMany({ where: { keyId: null } });
  for (const row of rows) {
    let keyId = generateKeyId();
    for (let i = 0; i < 5; i++) {
      try {
        await prisma.apiKey.update({ where: { id: row.id }, data: { keyId } });
        break;
      } catch {
        keyId = generateKeyId();
      }
    }
  }
}
