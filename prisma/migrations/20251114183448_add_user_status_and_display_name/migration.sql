/*
  Warnings:

  - You are about to drop the column `isActive` on the `users` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- AlterTable
ALTER TABLE "users" DROP COLUMN "isActive",
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "settings" JSONB,
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';
