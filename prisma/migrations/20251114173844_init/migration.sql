-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CITIZEN_DEVELOPER', 'PRO_DEVELOPER', 'ADMIN');

-- CreateEnum
CREATE TYPE "PlatformType" AS ENUM ('POWERAPPS', 'MENDIX', 'OUTSYSTEMS', 'SALESFORCE');

-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'LIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ComponentType" AS ENUM ('SCREEN', 'FORM', 'BUTTON', 'WORKFLOW', 'MICROFLOW', 'FORMULA', 'DATA_MODEL', 'API_CALL', 'OTHER');

-- CreateEnum
CREATE TYPE "ChangeStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'DEPLOYED');

-- CreateEnum
CREATE TYPE "ChangeType" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('REVIEW_ASSIGNED', 'REVIEW_APPROVED', 'REVIEW_REJECTED', 'CHANGE_REQUESTED', 'DEPLOYMENT_SUCCESS', 'DEPLOYMENT_FAILED', 'COMMENT_MENTION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT', 'DEPLOY', 'ROLLBACK', 'LOGIN', 'LOGOUT', 'CONNECT', 'DISCONNECT');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "settings" JSONB,
    "subscriptionPlan" TEXT NOT NULL DEFAULT 'free',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "auth0Id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'CITIZEN_DEVELOPER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CITIZEN_DEVELOPER',
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_connectors" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" "PlatformType" NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "PlatformType" NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "apps" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "platform" "PlatformType" NOT NULL,
    "status" "AppStatus" NOT NULL DEFAULT 'DRAFT',
    "version" TEXT,
    "metadata" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "components" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "type" "ComponentType" NOT NULL,
    "path" TEXT,
    "properties" JSONB,
    "codeBlock" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "changeType" "ChangeType" NOT NULL,
    "status" "ChangeStatus" NOT NULL DEFAULT 'DRAFT',
    "beforeMetadata" JSONB,
    "afterMetadata" JSONB,
    "beforeCode" TEXT,
    "afterCode" TEXT,
    "diffSummary" JSONB,
    "riskScore" INTEGER,
    "riskAssessment" JSONB,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "decision" TEXT,
    "feedback" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentId" TEXT,
    "content" TEXT NOT NULL,
    "mentions" TEXT[],
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandboxes" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "externalId" TEXT,
    "snapshot" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "triggeredBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "logs" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "git_commits" (
    "id" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "commitMessage" TEXT NOT NULL,
    "commitUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "git_commits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "scope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_metrics" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "metricType" TEXT NOT NULL,
    "metricValue" DOUBLE PRECISION NOT NULL,
    "dimensions" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutorials" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "tags" TEXT[],
    "difficulty" TEXT NOT NULL,
    "estimatedTime" INTEGER,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tutorials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_auth0Id_key" ON "users"("auth0Id");

-- CreateIndex
CREATE INDEX "users_organizationId_idx" ON "users"("organizationId");

-- CreateIndex
CREATE INDEX "users_auth0Id_idx" ON "users"("auth0Id");

-- CreateIndex
CREATE UNIQUE INDEX "users_organizationId_email_key" ON "users"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_key" ON "invitations"("token");

-- CreateIndex
CREATE INDEX "invitations_token_idx" ON "invitations"("token");

-- CreateIndex
CREATE INDEX "platform_connectors_organizationId_idx" ON "platform_connectors"("organizationId");

-- CreateIndex
CREATE INDEX "user_connections_userId_idx" ON "user_connections"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_connections_userId_platform_key" ON "user_connections"("userId", "platform");

-- CreateIndex
CREATE INDEX "apps_organizationId_idx" ON "apps"("organizationId");

-- CreateIndex
CREATE INDEX "apps_ownerId_idx" ON "apps"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "apps_organizationId_externalId_platform_key" ON "apps"("organizationId", "externalId", "platform");

-- CreateIndex
CREATE INDEX "components_appId_idx" ON "components"("appId");

-- CreateIndex
CREATE INDEX "changes_organizationId_idx" ON "changes"("organizationId");

-- CreateIndex
CREATE INDEX "changes_appId_idx" ON "changes"("appId");

-- CreateIndex
CREATE INDEX "changes_authorId_idx" ON "changes"("authorId");

-- CreateIndex
CREATE INDEX "changes_status_idx" ON "changes"("status");

-- CreateIndex
CREATE INDEX "reviews_changeId_idx" ON "reviews"("changeId");

-- CreateIndex
CREATE INDEX "reviews_reviewerId_idx" ON "reviews"("reviewerId");

-- CreateIndex
CREATE INDEX "reviews_status_idx" ON "reviews"("status");

-- CreateIndex
CREATE INDEX "comments_changeId_idx" ON "comments"("changeId");

-- CreateIndex
CREATE INDEX "comments_userId_idx" ON "comments"("userId");

-- CreateIndex
CREATE INDEX "sandboxes_appId_idx" ON "sandboxes"("appId");

-- CreateIndex
CREATE INDEX "deployments_changeId_idx" ON "deployments"("changeId");

-- CreateIndex
CREATE INDEX "deployments_status_idx" ON "deployments"("status");

-- CreateIndex
CREATE INDEX "git_commits_changeId_idx" ON "git_commits"("changeId");

-- CreateIndex
CREATE INDEX "policies_organizationId_idx" ON "policies"("organizationId");

-- CreateIndex
CREATE INDEX "notifications_userId_idx" ON "notifications"("userId");

-- CreateIndex
CREATE INDEX "notifications_isRead_idx" ON "notifications"("isRead");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_idx" ON "audit_logs"("organizationId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_timestamp_idx" ON "audit_logs"("timestamp");

-- CreateIndex
CREATE INDEX "analytics_metrics_organizationId_idx" ON "analytics_metrics"("organizationId");

-- CreateIndex
CREATE INDEX "analytics_metrics_metricType_idx" ON "analytics_metrics"("metricType");

-- CreateIndex
CREATE INDEX "analytics_metrics_timestamp_idx" ON "analytics_metrics"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "tutorials_slug_key" ON "tutorials"("slug");

-- CreateIndex
CREATE INDEX "tutorials_category_idx" ON "tutorials"("category");

-- CreateIndex
CREATE INDEX "tutorials_isPublished_idx" ON "tutorials"("isPublished");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_connections" ADD CONSTRAINT "user_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "platform_connectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changes" ADD CONSTRAINT "changes_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changes" ADD CONSTRAINT "changes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "changes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "changes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "changes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_commits" ADD CONSTRAINT "git_commits_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "changes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
