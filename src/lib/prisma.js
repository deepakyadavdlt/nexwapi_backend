// lib/prisma.js — single PrismaClient instance using the pg driver adapter.
// (Same stack as the reference project: @prisma/client + @prisma/adapter-pg.)
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

// Reuse the client across hot reloads in dev to avoid exhausting connections.
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__prisma ||
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.__prisma = prisma;

// Serialize a DB message to the shape the frontend expects (timestamps as ms).
export const toMessage = (m) => ({
  id: m.waId || m.id,
  from: m.direction === "out" ? "me" : undefined,
  direction: m.direction,
  type: m.type,
  text: m.text,
  mediaUrl: m.mediaUrl || null,
  filename: m.filename || null,
  status: m.status,
  at: m.at.getTime(),
});

const COLORS = ["#25D366", "#128C7E", "#34B7F1", "#7C3AED", "#F59E0B", "#EF4444"];
export const pickColor = (i) => COLORS[i % COLORS.length];
