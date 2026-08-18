/*
  Warnings:

  - You are about to drop the column `targetConfig` on the `Portfolio` table. All the data in the column will be lost.
  - Added the required column `rebalanceThreshold` to the `Holding` table without a default value. This is not possible if the table is not empty.
  - Added the required column `targetTotalAmount` to the `Portfolio` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Holding" ADD COLUMN     "rebalanceThreshold" DECIMAL(5,2) NOT NULL;

-- AlterTable
ALTER TABLE "Portfolio" DROP COLUMN "targetConfig",
ADD COLUMN     "targetTotalAmount" DECIMAL(12,2) NOT NULL;
