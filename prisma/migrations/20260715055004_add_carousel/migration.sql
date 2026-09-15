-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "cards" JSONB,
ADD COLUMN     "format" TEXT NOT NULL DEFAULT 'text';
