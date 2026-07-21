// lib/apiKey.js — API key hashing + lookup
import crypto from "crypto";
import { prisma } from "./prisma.js";

export function hashApiKey(rawKey) {
  return crypto.createHash("sha256").update(String(rawKey)).digest("hex");
}

export function keyPrefix(rawKey) {
  const s = String(rawKey);
  if (s.length <= 16) return s;
  return `${s.slice(0, 12)}…${s.slice(-4)}`;
}

function hashedStorageValue(rawKey) {
  return `sha256:${hashApiKey(rawKey)}`;
}

/** Find API key by raw value; supports hashed + legacy plaintext rows. */
export async function findApiKeyByRaw(rawKey) {
  if (!rawKey) return null;
  const key = String(rawKey);
  const hashed = hashedStorageValue(key);

  let row = await prisma.apiKey.findFirst({
    where: { key: hashed },
    include: { company: true },
  });
  if (row) return row;

  // Legacy plaintext lookup + one-time migration
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

export function publicApiKeyRow(row) {
  return {
    id: row.id,
    name: row.name,
    key: keyPrefix(row.key?.startsWith("nex_") ? row.key : "nex_••••••••••••"),
    createdAt: row.createdAt.getTime(),
    lastUsedAt: row.lastUsedAt?.getTime() || null,
  };
}
