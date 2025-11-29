/*
  Warnings:

  - You are about to drop the column `appId` on the `sandboxes` table. All the data in the column will be lost.
  - You are about to drop the column `externalId` on the `sandboxes` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `sandboxes` table. All the data in the column will be lost.
  - You are about to drop the column `snapshot` on the `sandboxes` table. All the data in the column will be lost.
  - Added the required column `createdById` to the `sandboxes` table without a default value. This is not possible if the table is not empty.
  - Added the required column `environment` to the `sandboxes` table without a default value. This is not possible if the table is not empty.
  - Added the required column `organizationId` to the `sandboxes` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'COMMENT_ADDED';

-- DropForeignKey
ALTER TABLE "sandboxes" DROP CONSTRAINT "sandboxes_appId_fkey";

-- DropIndex
DROP INDEX "sandboxes_appId_idx";

-- AlterTable
ALTER TABLE "sandboxes" DROP COLUMN "appId",
DROP COLUMN "externalId",
DROP COLUMN "isActive",
DROP COLUMN "snapshot",
ADD COLUMN     "createdById" TEXT NOT NULL,
ADD COLUMN     "environment" JSONB NOT NULL,
ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PROVISIONING';

-- CreateIndex
CREATE INDEX "sandboxes_organizationId_idx" ON "sandboxes"("organizationId");

-- CreateIndex
CREATE INDEX "sandboxes_createdById_idx" ON "sandboxes"("createdById");

-- CreateIndex
CREATE INDEX "sandboxes_status_idx" ON "sandboxes"("status");

-- CreateIndex
CREATE INDEX "sandboxes_expiresAt_idx" ON "sandboxes"("expiresAt");

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
