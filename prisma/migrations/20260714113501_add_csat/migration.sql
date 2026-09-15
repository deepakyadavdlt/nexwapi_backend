-- AlterTable
ALTER TABLE "Setting" ADD COLUMN     "csatEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "csatMessage" TEXT NOT NULL DEFAULT 'Thanks for chatting with us! How would you rate your experience?';
