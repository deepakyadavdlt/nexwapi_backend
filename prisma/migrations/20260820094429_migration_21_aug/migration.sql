/*
  Warnings:

  - The `plan` column on the `Payment` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Made the column `companyId` on table `Agent` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `ApiKey` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `Automation` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `Campaign` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `Contact` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `Drip` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `Flow` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `Label` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `Message` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `Product` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `Segment` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `Setting` required. This step will fail if there are existing NULL values in that column.
  - Made the column `companyId` on table `Template` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_userId_fkey";

-- DropIndex
DROP INDEX "Agent_email_key";

-- DropIndex
DROP INDEX "ApiKey_key_key";

-- DropIndex
DROP INDEX "Template_name_key";

-- AlterTable
ALTER TABLE "Agent" ALTER COLUMN "companyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ApiKey" ALTER COLUMN "companyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Automation" ALTER COLUMN "companyId" SET NOT NULL,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Campaign" ALTER COLUMN "companyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CatalogCollection" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CommerceOrder" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CommerceSetting" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Company" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Contact" ALTER COLUMN "companyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Drip" ALTER COLUMN "companyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Flow" ALTER COLUMN "companyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InteractiveList" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Label" ALTER COLUMN "companyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Message" ALTER COLUMN "companyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "plan",
ADD COLUMN     "plan" "PlanKey" NOT NULL DEFAULT 'growth',
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Plan" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PlatformSetting" ALTER COLUMN "id" SET DEFAULT 'default',
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "companyId" SET NOT NULL,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SalesLead" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Segment" ADD COLUMN     "description" TEXT,
ALTER COLUMN "companyId" SET NOT NULL,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Setting" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "companyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Subscription" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Template" ALTER COLUMN "companyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "adminReply" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'client',
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WhatsAppAccount" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WhatsAppForm" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "ApiKey_key_idx" ON "ApiKey"("key");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceSetting" ADD CONSTRAINT "CommerceSetting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogCollection" ADD CONSTRAINT "CatalogCollection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentRule" ADD CONSTRAINT "AssignmentRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppForm" ADD CONSTRAINT "WhatsAppForm_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InteractiveList" ADD CONSTRAINT "InteractiveList_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
