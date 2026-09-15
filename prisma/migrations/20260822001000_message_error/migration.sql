-- Store Meta Cloud API delivery error on outbound messages
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "error" TEXT;
