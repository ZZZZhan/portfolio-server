/*
  Warnings:

  - You are about to drop the `Probe` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('ETF', 'STOCK', 'FUND');

-- CreateEnum
CREATE TYPE "TradeType" AS ENUM ('EXCHANGE', 'OTC');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('PENDING', 'COMPLETED');

-- DropTable
DROP TABLE "Probe";

-- CreateTable
CREATE TABLE "Asset" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Portfolio" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "targetConfig" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Portfolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holding" (
    "id" SERIAL NOT NULL,
    "portfolioId" INTEGER NOT NULL,
    "assetId" INTEGER NOT NULL,
    "targetRatio" INTEGER NOT NULL,

    CONSTRAINT "Holding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" SERIAL NOT NULL,
    "holdingId" INTEGER NOT NULL,
    "type" "TradeType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "shares" DECIMAL(16,4),
    "price" DECIMAL(12,4),
    "tradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "TradeStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySnapshot" (
    "id" SERIAL NOT NULL,
    "portfolioId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "totalMarketValue" DECIMAL(14,2) NOT NULL,
    "totalCost" DECIMAL(14,2) NOT NULL,
    "totalProfit" DECIMAL(14,2) NOT NULL,
    "profitRate" DECIMAL(8,4) NOT NULL,
    "todayProfit" DECIMAL(14,2) NOT NULL,
    "todayProfitRate" DECIMAL(8,4) NOT NULL,
    "completion" DECIMAL(5,2) NOT NULL,
    "holdings" JSONB NOT NULL,

    CONSTRAINT "DailySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Asset_symbol_key" ON "Asset"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "Holding_portfolioId_assetId_key" ON "Holding"("portfolioId", "assetId");

-- CreateIndex
CREATE INDEX "Trade_holdingId_tradedAt_idx" ON "Trade"("holdingId", "tradedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DailySnapshot_portfolioId_date_key" ON "DailySnapshot"("portfolioId", "date");

-- AddForeignKey
ALTER TABLE "Holding" ADD CONSTRAINT "Holding_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holding" ADD CONSTRAINT "Holding_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "Holding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySnapshot" ADD CONSTRAINT "DailySnapshot_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;
