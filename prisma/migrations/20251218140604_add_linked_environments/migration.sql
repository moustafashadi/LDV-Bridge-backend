-- CreateTable
CREATE TABLE "linked_environments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "platform" "PlatformType" NOT NULL DEFAULT 'POWERAPPS',
    "environmentId" TEXT NOT NULL,
    "environmentUrl" TEXT,
    "region" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linked_environments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "linked_environments_organizationId_idx" ON "linked_environments"("organizationId");

-- CreateIndex
CREATE INDEX "linked_environments_createdById_idx" ON "linked_environments"("createdById");

-- CreateIndex
CREATE INDEX "linked_environments_platform_idx" ON "linked_environments"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "linked_environments_organizationId_environmentId_key" ON "linked_environments"("organizationId", "environmentId");

-- AddForeignKey
ALTER TABLE "linked_environments" ADD CONSTRAINT "linked_environments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linked_environments" ADD CONSTRAINT "linked_environments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
