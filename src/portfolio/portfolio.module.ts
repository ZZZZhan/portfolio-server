import { Module } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { TradeService } from './trade.service';
import { PortfolioController } from './portfolio.controller';

@Module({
  controllers: [PortfolioController],
  providers: [PortfolioService, TradeService],
})
export class PortfolioModule {}
