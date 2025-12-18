-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "githubRepoId" TEXT,
ADD COLUMN     "githubRepoName" TEXT,
ADD COLUMN     "githubRepoUrl" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "githubInstallationId" TEXT,
ADD COLUMN     "githubOrgName" TEXT;

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "githubPrNumber" INTEGER,
ADD COLUMN     "githubPrUrl" TEXT;

-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "githubBranch" TEXT;
