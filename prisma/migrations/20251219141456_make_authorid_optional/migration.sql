-- DropForeignKey
ALTER TABLE "changes" DROP CONSTRAINT "changes_authorId_fkey";

-- AlterTable
ALTER TABLE "changes" ALTER COLUMN "authorId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "changes" ADD CONSTRAINT "changes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
