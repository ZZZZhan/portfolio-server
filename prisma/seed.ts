// 种子数据：M1 验证用（fake userId=1，目标金额=用户设定演示）
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  // 清空旧数据（保持可重跑）
  await prisma.trade.deleteMany();
  await prisma.dailySnapshot.deleteMany();
  await prisma.holding.deleteMany();
  await prisma.portfolio.deleteMany();
  await prisma.asset.deleteMany();

  // 标的（用户 mock 里的组合）
  const hs300 = await prisma.asset.create({
    data: { symbol: '510300', name: '沪深300ETF', type: 'ETF', exchange: 'SH' },
  });
  const sp500 = await prisma.asset.create({
    data: { symbol: '513100', name: '标普500ETF', type: 'ETF', exchange: 'SH' },
  });
  const cyb = await prisma.asset.create({
    data: { symbol: '159915', name: '创业板ETF', type: 'ETF', exchange: 'SZ' },
  });
  const bond = await prisma.asset.create({
    data: { symbol: '511260', name: '债券基金', type: 'FUND', exchange: 'OTC' },
  });

  // 组合（目标金额 = 用户设定 80 万）
  const portfolio = await prisma.portfolio.create({
    data: {
      userId: 1, // fake userId（M3 接 better-auth）
      name: '稳健增值组合',
      targetTotalAmount: '800000',
      holdings: {
        create: [
          { assetId: hs300.id, targetRatio: 30, rebalanceThreshold: '5' },
          { assetId: sp500.id, targetRatio: 25, rebalanceThreshold: '5' },
          { assetId: cyb.id, targetRatio: 20, rebalanceThreshold: '5' },
          { assetId: bond.id, targetRatio: 25, rebalanceThreshold: '5' },
        ],
      },
    },
    include: { holdings: true },
  });

  console.log('种子完成：', {
    assets: 4,
    portfolio: portfolio.name,
    holdings: portfolio.holdings.length,
    targetTotalAmount: Number(portfolio.targetTotalAmount),
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
