import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './../src/app.module';
import { SnapshotCronService } from './../src/portfolio/snapshot-cron.service';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  NotificationProvider,
  NotificationMessage,
  NotificationResult,
} from './../src/notification/notification';
import { RebalanceNotifierService } from './../src/notification/rebalance-notifier.service';

/**
 * 再平衡推送编排 —— 集成测试。
 *
 * 用真实 Postgres 构造「配了 SendKey 的用户 + 组合 + 持仓 + 快照」，
 * 把 NotificationProvider mock 掉，直接调 RebalanceNotifierService.notifyAll()，
 * 验证：只挑偏离超该持仓 rebalanceThreshold 的项、只推给配了 SendKey 的用户。
 */
describe('RebalanceNotifierService (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifier: RebalanceNotifierService;
  const send = jest.fn<
    Promise<NotificationResult>,
    [string, NotificationMessage]
  >(() => ({ ok: true }));

  const email = `notify-${Date.now()}@test.local`;
  const symbolOver = '999990'; // 超阈值（用不会被真实行情影响的占位代码）
  const symbolOk = '999991'; // 未超阈值
  let userId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SnapshotCronService)
      .useValue({}) // 禁 cron
      .overrideProvider(NotificationProvider)
      .useValue({ send })
      .compile();

    app = moduleFixture.createNestApplication({ forceCloseConnections: true });
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    notifier = moduleFixture.get(RebalanceNotifierService);

    // 构造数据：有 SendKey 的用户 + 无 SendKey 的用户（用于验证不推）
    const u = await prisma.user.create({
      data: {
        id: `u-${Date.now()}`,
        name: '推送测试用户',
        email,
        emailVerified: false,
        sendkey: 'SCT_test',
      },
    });
    userId = u.id;
    const noKey = await prisma.user.create({
      data: {
        id: `u-nokey-${Date.now()}`,
        name: '无Key用户',
        email: `nokey-${email}`,
        emailVerified: false,
      },
    });

    // 组合：持仓 threshold=5，一个 currentRatio 偏离 20%（超），一个偏离 2%（不超）
    const aOver = await prisma.asset.create({
      data: {
        symbol: symbolOver,
        name: '偏离标的',
        type: 'ETF',
        exchange: 'SH',
      },
    });
    const aOk = await prisma.asset.create({
      data: { symbol: symbolOk, name: '正常标的', type: 'ETF', exchange: 'SH' },
    });
    const p = await prisma.portfolio.create({
      data: {
        userId,
        name: '推送测试组合',
        targetTotalAmount: '100000',
        holdings: {
          create: [
            { assetId: aOver.id, targetRatio: 50, rebalanceThreshold: 5 },
            { assetId: aOk.id, targetRatio: 50, rebalanceThreshold: 5 },
          ],
        },
      },
    });
    // 无 Key 用户的组合（不应被推送）
    await prisma.portfolio.create({
      data: {
        userId: noKey.id,
        name: '无Key组合',
        targetTotalAmount: '100000',
      },
    });

    // 落一条快照：over 偏离 +20%，ok 偏离 +2%
    const today = new Date(Date.UTC(2026, 0, 1));
    const holdingsJson = [
      {
        symbol: symbolOver,
        name: '偏离标的',
        currentRatio: 0.7,
        targetRatio: 0.5,
        deviation: 0.2,
      },
      {
        symbol: symbolOk,
        name: '正常标的',
        currentRatio: 0.52,
        targetRatio: 0.5,
        deviation: 0.02,
      },
    ];
    await prisma.dailySnapshot.create({
      data: {
        portfolioId: p.id,
        date: today,
        totalMarketValue: '100000',
        totalCost: '100000',
        totalProfit: '0',
        profitRate: '0',
        todayProfit: '0',
        todayProfitRate: '0',
        completion: '1',
        holdings: holdingsJson,
      },
    });
  });

  afterAll(async () => {
    // 清理（组合级联删 holding/snapshot；资产、用户按 id 删）
    await prisma.portfolio.deleteMany({ where: { userId } });
    await prisma.portfolio.deleteMany({
      where: { userId: { contains: 'u-nokey-' } },
    });
    await prisma.dailySnapshot.deleteMany();
    await prisma.asset.deleteMany({
      where: { symbol: { in: [symbolOver, symbolOk] } },
    });
    const noKey = await prisma.user.findFirst({
      where: { email: `nokey-${email}` },
    });
    if (noKey) await prisma.user.delete({ where: { id: noKey.id } });
    await prisma.user.delete({ where: { id: userId } });
    await app.close();
  });

  it('只向配了 SendKey 的用户推送、且只推偏离超阈值的持仓', async () => {
    send.mockClear();
    await notifier.notifyAll();

    // 从所有 send 调用中找出本测试组合的那条（测试库可能残留其它带 key 用户）
    const calls = send.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const targeted = calls.find(([key, msg]) => {
      return key === 'SCT_test' && msg.title.includes('推送测试组合');
    });
    expect(targeted).toBeDefined();
    const [key, message] = targeted as [string, NotificationMessage];

    // 用对的 sendkey
    expect(key).toBe('SCT_test');
    // title 带组合名
    expect(message.title).toContain('推送测试组合');
    // 文案包含超阈值项 + 状态，但不含未超阈值项
    expect(message.desp).toContain('偏离标的');
    expect(message.desp).toContain('超配');
    expect(message.desp).toContain('20.0%'); // 偏离 +20%
    expect(message.desp).not.toContain('正常标的'); // 未超阈值，不出现在提醒里
  });

  it('推送失败时记录为 skipped 而非抛错', async () => {
    send.mockImplementation(() => ({ ok: false, reason: '模拟失败' }));
    const result = await notifier.notifyAll();
    expect(result.notified).toBe(0);
    // notifyAll 会扫描所有配了 SendKey 的用户（测试库可能残留其它带 key 用户），
    // 因此只断言本测试用户也计入了 skipped（至少 1），不与具体残留数量耦合。
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});
