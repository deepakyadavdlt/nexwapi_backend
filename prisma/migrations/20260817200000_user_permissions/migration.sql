-- Platform staff section access (JSON array of permission keys)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "permissions" JSONB;
