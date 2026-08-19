import { Test, TestingModule } from '@nestjs/testing';
import { PortfolioController } from './portfolio.controller';
import { AssetSearchService } from './asset-search.service';
import { PortfolioService } from './portfolio.service';
import { SnapshotService } from './snapshot.service';
import { TradeService } from './trade.service';

describe('PortfolioController', () => {
  let controller: PortfolioController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PortfolioController],
      providers: [
        { provide: PortfolioService, useValue: {} },
        { provide: TradeService, useValue: {} },
        { provide: SnapshotService, useValue: {} },
        { provide: AssetSearchService, useValue: {} },
      ],
    }).compile();

    controller = module.get<PortfolioController>(PortfolioController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
