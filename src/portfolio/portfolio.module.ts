import { Module } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { TradeService } from './trade.service';
import { SnapshotService } from './snapshot.service';
import { PortfolioController } from './portfolio.controller';

@Module({
  controllers: [PortfolioController],
  providers: [PortfolioService, TradeService, SnapshotService],
})
export class PortfolioModule {}
