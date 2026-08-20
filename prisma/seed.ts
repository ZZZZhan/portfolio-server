// 种子数据：注册一个测试用户，并为其建演示组合（验证 better-auth 接入）
import { PrismaClient } from '../src/generated/prisma/client';
import { getPrismaAdapter } from '../src/lib/prisma';
import { auth } from '../src/lib/auth';
import 'dotenv/config';

const prisma = new PrismaClient({ adapter: getPrismaAdapter() });

async function main() {
  // 清空旧数据（保持可重跑）。注意先删业务表，再删用户（外键级联）。
  await prisma.trade.deleteMany();
  await prisma.dailySnapshot.deleteMany();
  await prisma.holding.deleteMany();
  await prisma.portfolio.deleteMany();
  await prisma.asset.deleteMany();
  // 用户/会话等由 better-auth 管理，重跑时也清掉
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  await prisma.user.deleteMany();

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

  // 通过 better-auth 注册测试用户（邮箱已存在时复用现有用户）
  const email = 'demo@portfolio.local';
  const existing = await prisma.user.findUnique({ where: { email } });
  let userId: string;
  if (existing) {
    userId = existing.id;
  } else {
    const res = await auth.api.signUpEmail({
      body: { name: '演示用户', email, password: 'password123' },
    });
    // 返回结构：{ token?, user: { id, ... } }（不同版本字段可能略有差异）
    const created =
      (res as any)?.user ??
      (res as any)?.data?.user ??
      (res as any)?.result?.user;
    userId = created.id;
  }

  // 组合（目标金额 = 用户设定 80 万）
  const portfolio = await prisma.portfolio.create({
    data: {
      userId,
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
    user: email,
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
