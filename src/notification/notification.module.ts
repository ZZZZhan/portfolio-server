import { Module } from '@nestjs/common';
import {
  NotificationProvider,
  NotificationMessage,
  NotificationResult,
} from './notification';
import { ServerChanProvider } from './server-chan.provider';

/**
 * 通知（微信推送）模块。
 *
 * 默认绑定 ServerChanProvider 为 NotificationProvider 抽象类的实现。
 * 测试 / 未来换服务商时，用 `Test.overrideProvider(NotificationProvider)`
 * 替换，或此处改 useClass，调用方零改动。
 *
 * 只导出抽象类 token，不导出具体实现（同 PriceProvider 模式）。
 */
@Module({
  providers: [
    { provide: NotificationProvider, useClass: ServerChanProvider },
    ServerChanProvider,
  ],
  exports: [NotificationProvider],
})
export class NotificationModule {}

// 便于其它文件按需引用类型（避免窄 import 路径）
export type { NotificationMessage, NotificationResult };
