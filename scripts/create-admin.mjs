// scripts/create-admin.mjs
// Create (or update) the admin login and save it to the database.
//
// Usage:
//   node scripts/create-admin.mjs <email> <password> [name]
//   -- or set env vars --
//   ADMIN_EMAIL=you@nexwapi.com ADMIN_PASSWORD=Secret123 node scripts/create-admin.mjs
//
// The password is bcrypt-hashed before it is stored. Re-running with the same
// email updates that admin's password (safe to run again).

import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/auth.js";

const email = (process.argv[2] || process.env.ADMIN_EMAIL || "").toLowerCase().trim();
const password = process.argv[3] || process.env.ADMIN_PASSWORD || "";
const name = process.argv[4] || process.env.ADMIN_NAME || "Admin";

if (!email || !password) {
  console.error("\n  Missing details.\n  Usage: node scripts/create-admin.mjs <email> <password> [name]\n");
  process.exit(1);
}
if (password.length < 6) {
  console.error("\n  Password must be at least 6 characters.\n");
  process.exit(1);
}

const hash = await hashPassword(password);
const user = await prisma.user.upsert({
  where: { email },
  update: { password: hash, role: "Owner", plan: "pro", name },
  create: { email, password: hash, name, company: "Nexwapi", role: "Owner", plan: "pro" },
});

console.log("\n  ✅ Admin ready");
console.log("     email:", user.email);
console.log("     role :", user.role, "| plan:", user.plan);
console.log("\n  Log in at /login with this email and the password you set.\n");
process.exit(0);
