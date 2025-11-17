-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "message" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "requestedRole" "UserRole";

-- CreateTable
CREATE TABLE "invitation_codes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CITIZEN_DEVELOPER',
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitation_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "auth0Id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "requestedRole" "UserRole" NOT NULL DEFAULT 'CITIZEN_DEVELOPER',
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitation_codes_code_key" ON "invitation_codes"("code");

-- CreateIndex
CREATE INDEX "invitation_codes_code_idx" ON "invitation_codes"("code");

-- CreateIndex
CREATE INDEX "invitation_codes_organizationId_idx" ON "invitation_codes"("organizationId");

-- CreateIndex
CREATE INDEX "organization_requests_organizationId_idx" ON "organization_requests"("organizationId");

-- CreateIndex
CREATE INDEX "organization_requests_auth0Id_idx" ON "organization_requests"("auth0Id");

-- CreateIndex
CREATE INDEX "organization_requests_status_idx" ON "organization_requests"("status");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- AddForeignKey
ALTER TABLE "invitation_codes" ADD CONSTRAINT "invitation_codes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_requests" ADD CONSTRAINT "organization_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
