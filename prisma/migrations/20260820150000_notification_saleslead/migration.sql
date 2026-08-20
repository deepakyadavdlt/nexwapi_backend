-- Notification + SalesLead tables missing on some production DBs

CREATE TABLE IF NOT EXISTS "Notification" (
    "id" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'client',
    "userId" TEXT,
    "companyId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "href" TEXT NOT NULL DEFAULT '',
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Notification_audience_createdAt_idx" ON "Notification"("audience", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_companyId_createdAt_idx" ON "Notification"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_read_idx" ON "Notification"("userId", "read");

CREATE TABLE IF NOT EXISTS "SalesLead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "company" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesLead_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "availability" TEXT NOT NULL DEFAULT 'online';
