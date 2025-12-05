-- CreateTable
CREATE TABLE "sandbox_clones" (
    "id" TEXT NOT NULL,
    "sourceAppId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "clonedAppId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_clones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sandbox_clones_sourceAppId_idx" ON "sandbox_clones"("sourceAppId");

-- CreateIndex
CREATE INDEX "sandbox_clones_sandboxId_idx" ON "sandbox_clones"("sandboxId");

-- CreateIndex
CREATE INDEX "sandbox_clones_organizationId_idx" ON "sandbox_clones"("organizationId");

-- AddForeignKey
ALTER TABLE "sandbox_clones" ADD CONSTRAINT "sandbox_clones_sourceAppId_fkey" FOREIGN KEY ("sourceAppId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_clones" ADD CONSTRAINT "sandbox_clones_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_clones" ADD CONSTRAINT "sandbox_clones_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_clones" ADD CONSTRAINT "sandbox_clones_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
