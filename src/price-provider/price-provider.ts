import { Exchange } from '../generated/prisma/client';

/**
 * PriceProvider —— 行情源适配器抽象类（SPEC 唯一内部缝）。
 *
 * 所有对外行情调用集中在此抽象背后，便于：
 * 1. 测试注入 fake 返回固定价格（e2e 主缝依赖此能力）
 * 2. 未来换源（腾讯 / 东方财富 / Tushare）只新增一个实现并切换模块绑定
 * 3. 多源 fallback 链可在此抽象内组合，调用方无感
 *
 * 调用方（SnapshotService / cron）只依赖本抽象类的 token，
 * 不直接 import 任何具体源实现。
 */

/**
 * 单个标的的取价结果。
 * - price：最新价（场内收盘价 / 场外净值）
 * - date：行情日期 YYYY-MM-DD，用于判断「今日净值是否已公布」
 *   场外基金净值晚公布时，源可能返回上一交易日净值，date 会早于今天
 */
export interface PriceResult {
  symbol: string;
  price: number;
  date: string; // YYYY-MM-DD
}

/**
 * 取价入参：标的代码 + 交易所（决定拼新浪前缀 sh / sz / of）。
 */
export interface PriceQuery {
  symbol: string;
  exchange: Exchange;
}

/**
 * 行情源抽象类 —— 同时充当 Nest DI token。
 * 具体实现（Sina / Tencent / fake）继承它并实现 getPrices。
 * 模块里用 `{ provide: PriceProvider, useClass: SinaPriceProvider }` 绑定。
 */
export abstract class PriceProvider {
  /**
   * 批量取价。失败的标的直接不出现在结果里（降级，不抛错，对齐 SPEC 第 12 条）。
   * 调用方对缺失的标的自行决定用最近快照价兜底。
   */
  abstract getPrices(queries: PriceQuery[]): Promise<PriceResult[]>;
}
