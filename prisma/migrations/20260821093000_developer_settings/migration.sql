-- Developer settings: reject opted-out contacts on Message Send API
ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "rejectOptedOutApi" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "webhookUrl" TEXT NOT NULL DEFAULT '';
