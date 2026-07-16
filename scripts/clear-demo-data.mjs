// scripts/clear-demo-data.mjs
// Wipe all demo/dummy CONTENT so you start clean for real clients.
// KEEPS: users (admin + client logins) and settings.
// CLEARS: contacts, messages, campaigns, drips, flows, templates, automations,
//         notes, events, labels, segments, products, quick replies, api keys.
//
// Usage (guard flag required so it can't run by accident):
//   node scripts/clear-demo-data.mjs --yes

import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

if (!process.argv.includes("--yes")) {
  console.error("\n  This deletes all demo content (keeps users + settings).");
  console.error("  Re-run with --yes to confirm:  node scripts/clear-demo-data.mjs --yes\n");
  process.exit(1);
}

// Order matters for FK constraints — children before parents.
const steps = [
  ["dripEnrollment", () => prisma.dripEnrollment.deleteMany()],
  ["note", () => prisma.note.deleteMany()],
  ["event", () => prisma.event.deleteMany()],
  ["message", () => prisma.message.deleteMany()],
  ["payment", () => prisma.payment.deleteMany()],
  ["contact", () => prisma.contact.deleteMany()],
  ["campaign", () => prisma.campaign.deleteMany()],
  ["drip", () => prisma.drip.deleteMany()],
  ["flow", () => prisma.flow.deleteMany()],
  ["template", () => prisma.template.deleteMany()],
  ["automation", () => prisma.automation.deleteMany()],
  ["quickReply", () => prisma.quickReply.deleteMany()],
  ["label", () => prisma.label.deleteMany()],
  ["segment", () => prisma.segment.deleteMany()],
  ["product", () => prisma.product.deleteMany()],
  ["apiKey", () => prisma.apiKey.deleteMany()],
];

for (const [name, run] of steps) {
  try {
    const r = await run();
    console.log(`  cleared ${name}: ${r.count ?? 0}`);
  } catch (e) {
    console.log(`  skip ${name}: ${e?.message?.split("\n")[0] || e}`);
  }
}
console.log("\n  ✅ Demo content cleared. Users & settings kept.\n");
process.exit(0);
