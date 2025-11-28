-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('QUEUED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncTriggerType" AS ENUM ('MANUAL', 'AUTOMATIC', 'WEBHOOK');

-- CreateTable
CREATE TABLE "sync_history" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "platform" "PlatformType" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'QUEUED',
    "jobId" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "triggerType" "SyncTriggerType" NOT NULL DEFAULT 'MANUAL',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "itemsSynced" INTEGER,
    "errorMessage" TEXT,
    "errorStack" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_history_organizationId_idx" ON "sync_history"("organizationId");

-- CreateIndex
CREATE INDEX "sync_history_appId_idx" ON "sync_history"("appId");

-- CreateIndex
CREATE INDEX "sync_history_status_idx" ON "sync_history"("status");

-- CreateIndex
CREATE INDEX "sync_history_createdAt_idx" ON "sync_history"("createdAt");

-- AddForeignKey
ALTER TABLE "sync_history" ADD CONSTRAINT "sync_history_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
