-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "chatStatus" TEXT NOT NULL DEFAULT 'open';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "filename" TEXT,
ADD COLUMN     "mediaUrl" TEXT;
