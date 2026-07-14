-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "awayEnabled" BOOLEAN NOT NULL DEFAULT false,
    "awayMessage" TEXT NOT NULL DEFAULT 'Thanks for messaging! We''re away right now and will reply during business hours.',
    "hoursStart" INTEGER NOT NULL DEFAULT 9,
    "hoursEnd" INTEGER NOT NULL DEFAULT 18,
    "days" TEXT[] DEFAULT ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri']::TEXT[],
    "businessName" TEXT NOT NULL DEFAULT 'Nexwapi',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_key" ON "ApiKey"("key");
