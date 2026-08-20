import { Module } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { TradeService } from './trade.service';
import { SnapshotService } from './snapshot.service';
import { SnapshotCronService } from './snapshot-cron.service';
import { AssetSearchService } from './asset-search.service';
import { PortfolioController } from './portfolio.controller';
import { PriceProviderModule } from '../price-provider/price-provider.module';
import { NotificationModule } from '../notification/notification.module';
import { RebalanceNotifierService } from '../notification/rebalance-notifier.service';

@Module({
  // PriceProviderModule: 供 SnapshotService / CronService 注入行情源
  // NotificationModule: 供 RebalanceNotifierService 注入推送适配器（微信提醒）
  imports: [PriceProviderModule, NotificationModule],
  controllers: [PortfolioController],
  providers: [
    PortfolioService,
    TradeService,
    SnapshotService,
    SnapshotCronService,
    AssetSearchService,
    RebalanceNotifierService,
  ],
})
export class PortfolioModule {}
