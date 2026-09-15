-- CreateTable
CREATE TABLE "Drip" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Drip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DripEnrollment" (
    "id" TEXT NOT NULL,
    "dripId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "nextAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DripEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DripEnrollment_status_nextAt_idx" ON "DripEnrollment"("status", "nextAt");

-- AddForeignKey
ALTER TABLE "DripEnrollment" ADD CONSTRAINT "DripEnrollment_dripId_fkey" FOREIGN KEY ("dripId") REFERENCES "Drip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
