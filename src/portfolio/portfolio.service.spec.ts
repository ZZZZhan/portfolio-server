import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PortfolioService } from './portfolio.service';
import { SnapshotService } from './snapshot.service';

/** 事务里用到的 prisma 委托，与外层共用同一组 mock */
function makeTx() {
  return {
    portfolio: { update: jest.fn().mockResolvedValue({}) },
    holding: {
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    asset: {
      upsert: jest.fn().mockResolvedValue({ id: 99 }),
    },
  };
}

/** 组合 1 现有两条持仓：510300 / 513100 */
const EXISTING_PORTFOLIO = {
  id: 1,
  userId: 'u1',
  holdings: [
    { id: 11, asset: { symbol: '510300' } },
    { id: 12, asset: { symbol: '513100' } },
  ],
};

/** 一条合法的持仓入参 */
function holdingInput(symbol: string, targetRatio: number) {
  return {
    symbol,
    name: symbol,
    assetType: 'ETF' as const,
    exchange: 'SH' as const,
    targetRatio,
    rebalanceThreshold: 5,
  };
}

describe('PortfolioService', () => {
  let service: PortfolioService;
  let tx: ReturnType<typeof makeTx>;
  let prisma: {
    portfolio: { findFirst: jest.Mock; delete: jest.Mock };
    holding: { findFirst: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let snapshot: { calculateAndSave: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    prisma = {
      portfolio: { findFirst: jest.fn(), delete: jest.fn() },
      holding: { findFirst: jest.fn(), update: jest.fn() },
      // 交互式事务：把同一组 mock 交给回调
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    };
    snapshot = { calculateAndSave: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioService,
        { provide: PrismaService, useValue: prisma },
        { provide: SnapshotService, useValue: snapshot },
      ],
    }).compile();

    service = module.get<PortfolioService>(PortfolioService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('updateHolding', () => {
    it('持仓不存在或不属于当前用户时抛 404，且不落库', async () => {
      prisma.holding.findFirst.mockResolvedValue(null);

      await expect(
        service.updateHolding(1, 2, 'someone-else', {
          rebalanceThreshold: 5,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.holding.update).not.toHaveBeenCalled();
    });

    it('归属校验同时限定 portfolioId 与 userId，阈值以字符串写入 Decimal', async () => {
      prisma.holding.findFirst.mockResolvedValue({ id: 2 });
      prisma.holding.update.mockResolvedValue({ id: 2 });

      await service.updateHolding(1, 2, 'u1', { rebalanceThreshold: 7.5 });

      expect(prisma.holding.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 2, portfolioId: 1, portfolio: { userId: 'u1' } },
        }),
      );
      expect(prisma.holding.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 2 },
          data: { rebalanceThreshold: '7.5' },
        }),
      );
    });
  });

  describe('update', () => {
    it('组合不属于当前用户时抛 404，事务不启动', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(
        service.update(1, { name: '改个名' }, 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('配比之和不等于 100 时抛 400，事务不启动', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(EXISTING_PORTFOLIO);

      await expect(
        service.update(
          1,
          { holdings: [holdingInput('510300', 60), holdingInput('513100', 30)] },
          'u1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('按 symbol 分派增 / 改 / 删三类操作', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(EXISTING_PORTFOLIO);

      await service.update(
        1,
        {
          holdings: [
            holdingInput('510300', 50), // 已有 → 改
            holdingInput('159915', 50), // 新增 → upsert asset + 建持仓
            // 513100 不在列表里 → 删
          ],
        },
        'u1',
      );

      // 删掉的是 513100 对应的 holding.id=12
      expect(tx.holding.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [12] } },
      });
      // 已有的按 holding.id 改，不是按 symbol
      expect(tx.holding.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 11 } }),
      );
      expect(tx.asset.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { symbol: '159915' } }),
      );
      expect(tx.holding.create).toHaveBeenCalledTimes(1);
    });

    it('只改组合名时不动持仓', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(EXISTING_PORTFOLIO);

      await service.update(1, { name: '新名字' }, 'u1');

      expect(tx.portfolio.update).toHaveBeenCalled();
      expect(tx.holding.deleteMany).not.toHaveBeenCalled();
      expect(tx.holding.update).not.toHaveBeenCalled();
      expect(tx.holding.create).not.toHaveBeenCalled();
    });

    it('改完重算快照：配比变了偏离度也变了', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(EXISTING_PORTFOLIO);

      await service.update(
        1,
        { holdings: [holdingInput('510300', 100)] },
        'u1',
      );

      expect(snapshot.calculateAndSave).toHaveBeenCalledWith(1);
    });

    it('重算快照失败不影响更新结果', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(EXISTING_PORTFOLIO);
      snapshot.calculateAndSave.mockRejectedValue(new Error('行情源挂了'));

      await expect(
        service.update(1, { name: '新名字' }, 'u1'),
      ).resolves.toEqual({ message: '更新成功' });
    });
  });

  describe('remove', () => {
    it('组合不属于当前用户时抛 404，且不删库', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(service.remove(1, 'someone-else')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(prisma.portfolio.delete).not.toHaveBeenCalled();
    });

    it('归属校验通过后删除组合（持仓/交易/快照由数据库级联）', async () => {
      prisma.portfolio.findFirst.mockResolvedValue({ id: 1 });
      prisma.portfolio.delete.mockResolvedValue({ id: 1 });

      await expect(service.remove(1, 'u1')).resolves.toEqual({
        message: '删除成功',
      });

      expect(prisma.portfolio.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 1, userId: 'u1' } }),
      );
      expect(prisma.portfolio.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });
  });
});
