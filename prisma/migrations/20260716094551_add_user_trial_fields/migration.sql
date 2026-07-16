-- AlterTable
ALTER TABLE "User" ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'trial',
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);
