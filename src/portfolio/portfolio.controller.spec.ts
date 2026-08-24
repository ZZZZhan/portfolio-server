import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PortfolioController } from './portfolio.controller';
import { AssetSearchService } from './asset-search.service';
import { PortfolioService } from './portfolio.service';
import { SnapshotService } from './snapshot.service';
import { TradeService } from './trade.service';

describe('PortfolioController', () => {
  let controller: PortfolioController;
  let portfolioService: { assertOwned: jest.Mock };
  let snapshotService: { calculateAndSave: jest.Mock; getLatest: jest.Mock };

  beforeEach(async () => {
    portfolioService = { assertOwned: jest.fn() };
    snapshotService = {
      calculateAndSave: jest.fn(),
      getLatest: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PortfolioController],
      providers: [
        { provide: PortfolioService, useValue: portfolioService },
        { provide: TradeService, useValue: {} },
        { provide: SnapshotService, useValue: snapshotService },
        { provide: AssetSearchService, useValue: {} },
      ],
    }).compile();

    controller = module.get<PortfolioController>(PortfolioController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  const session = { user: { id: 'user-1' } } as never;

  describe('快照接口归属校验', () => {
    it('POST /:id/snapshot 先校验组合归属，所属才触发快照计算', async () => {
      portfolioService.assertOwned.mockResolvedValue({ id: 1 });
      snapshotService.calculateAndSave.mockResolvedValue({ written: true });

      await controller.runSnapshot(1, session);

      expect(portfolioService.assertOwned).toHaveBeenCalledWith(1, 'user-1');
      expect(snapshotService.calculateAndSave).toHaveBeenCalledWith(1);
    });

    it('POST /:id/snapshot 归属校验失败时不触发快照计算', async () => {
      portfolioService.assertOwned.mockRejectedValue(
        new NotFoundException('组合不存在或不属于当前用户'),
      );

      await expect(controller.runSnapshot(1, session)).rejects.toThrow(
        NotFoundException,
      );
      expect(snapshotService.calculateAndSave).not.toHaveBeenCalled();
    });

    it('GET /:id/snapshot 先校验组合归属，所属才读快照', async () => {
      portfolioService.assertOwned.mockResolvedValue({ id: 1 });
      snapshotService.getLatest.mockResolvedValue(null);

      await controller.getLatestSnapshot(1, session);

      expect(portfolioService.assertOwned).toHaveBeenCalledWith(1, 'user-1');
      expect(snapshotService.getLatest).toHaveBeenCalledWith(1);
    });
  });
});
