-- Add optional sender metadata on outbound/inbound messages (team inbox attribution).
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "senderName" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "senderUserId" TEXT;
