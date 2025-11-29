-- CreateEnum
CREATE TYPE "AppAccessLevel" AS ENUM ('VIEWER', 'EDITOR', 'OWNER');

-- CreateTable
CREATE TABLE "app_permissions" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessLevel" "AppAccessLevel" NOT NULL DEFAULT 'VIEWER',
    "grantedBy" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_permissions_userId_idx" ON "app_permissions"("userId");

-- CreateIndex
CREATE INDEX "app_permissions_appId_idx" ON "app_permissions"("appId");

-- CreateIndex
CREATE UNIQUE INDEX "app_permissions_appId_userId_key" ON "app_permissions"("appId", "userId");

-- AddForeignKey
ALTER TABLE "app_permissions" ADD CONSTRAINT "app_permissions_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_permissions" ADD CONSTRAINT "app_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_permissions" ADD CONSTRAINT "app_permissions_grantedBy_fkey" FOREIGN KEY ("grantedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
