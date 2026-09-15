// prisma.config.ts — Prisma 7 config.
// In Prisma 7 the connection URL lives here (not in schema.prisma). The runtime
// PrismaClient uses the pg driver adapter (see src/lib/prisma.js).
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
  },
  migrations: {
    path: "prisma/migrations",
  },
});
