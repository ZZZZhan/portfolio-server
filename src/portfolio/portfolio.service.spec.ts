import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PortfolioService } from './portfolio.service';

describe('PortfolioService', () => {
  let service: PortfolioService;
  let prisma: {
    holding: { findFirst: jest.Mock; update: jest.Mock };
  };

  beforeEach(async () => {
    prisma = { holding: { findFirst: jest.fn(), update: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioService,
        { provide: PrismaService, useValue: prisma },
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
});
