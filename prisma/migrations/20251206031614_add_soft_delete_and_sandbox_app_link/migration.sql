-- AlterTable
ALTER TABLE "changes" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT;

-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "appId" TEXT;

-- CreateIndex
CREATE INDEX "changes_deletedAt_idx" ON "changes"("deletedAt");

-- CreateIndex
CREATE INDEX "sandboxes_appId_idx" ON "sandboxes"("appId");

-- AddForeignKey
ALTER TABLE "changes" ADD CONSTRAINT "changes_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
