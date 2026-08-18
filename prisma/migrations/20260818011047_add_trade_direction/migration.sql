/*
  Warnings:

  - Added the required column `direction` to the `Trade` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "TradeDirection" AS ENUM ('BUY', 'SELL');

-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "direction" "TradeDirection" NOT NULL;
