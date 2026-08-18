import { Module } from '@nestjs/common';
import { PriceProvider } from './price-provider';
import { SinaPriceProvider } from './sina-price-provider.service';

/**
 * 行情源模块。
 *
 * 默认绑定 SinaPriceProvider 为 PriceProvider 抽象类的实现。
 * 测试 / 未来换源时，用 `Test.overrideProvider(PriceProvider).useValue(fake)` 替换，
 * 或此处改 `useClass: TencentPriceProvider / useFactory: 多源 fallback`，调用方零改动。
 */
@Module({
  providers: [
    { provide: PriceProvider, useClass: SinaPriceProvider },
    SinaPriceProvider,
  ],
  exports: [PriceProvider], // 只导出抽象类 token，不导出具体实现
})
export class PriceProviderModule {}
