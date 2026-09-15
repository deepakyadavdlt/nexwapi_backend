-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "scheduledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Setting" ADD COLUMN     "autoAssign" BOOLEAN NOT NULL DEFAULT false;
