import { Injectable } from '@nestjs/common';
import { Prisma, Exchange } from '../generated/prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PriceProvider } from '../price-provider/price-provider';
import { computeSnapshot, SnapshotResult, TradeInput } from './calc';

/**
 * calculateAndSave 返回值：在纯计算结果上追加行情日期元信息。
 * marketDate = 本次取到的行情日期（YYYY-MM-DD）。
 * 为 null 表示行情源一项都没返回（全部走兜底价），今天无真实收盘行情，
 * 调用方（cron）据此决定是否落当日快照。
 */
export type SnapshotWithDate = SnapshotResult & {
  marketDate: string | null; // 取自行情源的最新日期
  written: boolean; // 本次是否真的落库（onlyIfMarketToday 时非当日收盘则不写）
};

/**
 * 一轮批量计算共用的行情快照。
 *
 * 逐组合各取一次价时，同一个标的会被不同用户的组合重复拉（100 个组合都持有
 * 510300 就拉 100 次）。预取按 symbol 去重、一次拿全，外部请求数从
 * O(组合数) 降到 O(去重标的数 / 批大小)。
 */
export interface PrefetchedPrices {
  /** { symbol: 最新价 }，源没返回的标的不在表里，由各组合自行兜底 */
  prices: Record<string, number>;
  /** 本批行情的最新日期，全部取价失败为 null */
  marketDate: string | null;
}

@Injectable()
export class SnapshotService {
  constructor(
    private prisma: PrismaService,
    private priceProvider: PriceProvider, // 行情源，可注入替换（Sina / 未来 Tencent / 测试 fake）
  ) {}

  /**
   * 为一批组合预取行情：取这些组合持有的标的并集，去重后批量拉一次。
   *
   * 结果传给 calculateAndSave 的 options.prefetched，整轮只打一次行情源。
   * 取价失败不抛错（沿用 PriceProvider 的降级约定），缺的标的各组合走自己的兜底。
   *
   * @param portfolioIds 限定组合；不传表示全部组合
   */
  async prefetchPrices(portfolioIds?: number[]): Promise<PrefetchedPrices> {
    // asset.symbol 唯一，按「被持有」过滤即天然去重
    const assets = await this.prisma.asset.findMany({
      where: {
        holdings: portfolioIds
          ? { some: { portfolioId: { in: portfolioIds } } }
          : { some: {} },
      },
      select: { symbol: true, exchange: true },
    });
    if (assets.length === 0) return { prices: {}, marketDate: null };

    const fetched = await this.priceProvider.getPrices(assets);
    return {
      prices: Object.fromEntries(fetched.map((r) => [r.symbol, r.price])),
      marketDate: this.latestDate(fetched),
    };
  }

  /** 计算某组合的当日快照并写入 DailySnapshot（同组合同日 upsert） */
  async calculateAndSave(
    portfolioId: number,
    date = new Date(),
    options: {
      onlyIfMarketToday?: boolean;
      /** 批量场景下由 prefetchPrices 预取的行情，省掉本组合自己再打一次源 */
      prefetched?: PrefetchedPrices;
    } = {},
  ): Promise<SnapshotWithDate> {
    const onlyIfMarketToday = options.onlyIfMarketToday ?? false;
    // 1. 查组合（含 targetTotalAmount）
    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: portfolioId },
    });
    if (!portfolio) throw new Error(`组合不存在: ${portfolioId}`);

    // 2. 查该组合的所有持仓，含标的 + 交易（约定按 tradedAt 升序）
    const holdings = await this.prisma.holding.findMany({
      where: { portfolioId },
      include: { asset: true, trades: { orderBy: { tradedAt: 'asc' } } },
    });

    // 3. 批量取价（行情源）+ 本次行情日期
    const { prices, marketDate } = await this.fetchPrices(
      holdings,
      options.prefetched,
    );

    // 4. 组装 computeSnapshot 输入
    const input = {
      portfolioId,
      targetTotalAmount: Number(portfolio.targetTotalAmount),
      holdings: holdings.map((h) => ({
        symbol: h.asset.symbol,
        name: h.asset.name,
        targetRatio: h.targetRatio / 100, // 25 → 0.25
        price: prices[h.asset.symbol] ?? 0, // 行情缺失时兜底 0（见 fetchPrices）
        trades: h.trades.map<TradeInput>((t) => ({
          type: t.type,
          direction: t.direction,
          amount: Number(t.amount),
          shares: t.shares != null ? Number(t.shares) : null,
          price: t.price != null ? Number(t.price) : null,
          status: t.status,
        })),
      })),
    };

    // 5. 纯函数计算
    const result = computeSnapshot(input);

    // 6. 今日收益 = 今日市值 − 昨日市值（需昨日快照；无昨日基数则为 0）
    const yesterday = await this.prisma.dailySnapshot.findFirst({
      where: { portfolioId, date: { lt: this.asDateOnly(date) } },
      orderBy: { date: 'desc' },
    });
    let todayProfit = 0;
    let todayProfitRate = 0;
    if (yesterday && Number(yesterday.totalMarketValue) > 0) {
      todayProfit =
        result.totalMarketValue - Number(yesterday.totalMarketValue);
      todayProfitRate = todayProfit / Number(yesterday.totalMarketValue);
    }

    // 7. 若 onlyIfMarketToday 且行情日期非 request date（非交易日/节假日/源未收盘），
    //    则不落当日快照（避免周末/假期写一条相同值的占位行，干扰“最近交易日”判断）
    const today = this.asDateOnly(date);
    const todayStr = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');
    const written =
      !onlyIfMarketToday || (marketDate !== null && marketDate >= todayStr);

    if (written) {
      await this.saveSnapshot(
        portfolioId,
        date,
        result,
        todayProfit,
        todayProfitRate,
      );
    }

    return { ...result, marketDate, written };
  }

  /**
   * 批量取价并构造成 { symbol: price }，同时返回本次行情日期。
   * 源返回不了的标的走降级兜底：
   *   1. 该标的最近一次 COMPLETED 成交价/净值（trade.price）
   *   2. 仍无 → 0（市值视为 0）
   * 对齐 SPEC 第 12 条：行情源不可用时服务仍可用，不抛错。
   *
   * marketDate：取自行情源返回的最新日期。若行情源一项都没返回
   * （全部兜底），为 null —— 表示今天无真实收盘行情，cron 据此决定是否落当日快照。
   *
   * prefetched 有值时直接用它，不再打行情源；兜底逻辑照旧（兜底要看本组合自己的
   * 成交价，没法预取）。
   */
  private async fetchPrices(
    holdings: {
      asset: { symbol: string; exchange: Exchange };
      trades: { price: Prisma.Decimal | null; status: string }[];
    }[],
    prefetched?: PrefetchedPrices,
  ): Promise<{ prices: Record<string, number>; marketDate: string | null }> {
    let prices: Record<string, number>;
    let marketDate: string | null;

    if (prefetched) {
      // 只挑本组合用得上的，避免把整轮的价格表塞进单组合的计算输入
      prices = {};
      for (const h of holdings) {
        const p = prefetched.prices[h.asset.symbol];
        if (p != null) prices[h.asset.symbol] = p;
      }
      marketDate = prefetched.marketDate;
    } else {
      const fetched = await this.priceProvider.getPrices(
        holdings.map((h) => ({
          symbol: h.asset.symbol,
          exchange: h.asset.exchange,
        })),
      );
      prices = Object.fromEntries(fetched.map((r) => [r.symbol, r.price]));
      // 本次行情日期：取行情源返回的最新日期（场外净值可能晚出，不影响判断今日）
      marketDate = this.latestDate(fetched);
    }

    // 行情缺失的标的，用最近一次 COMPLETED 成交价兜底
    for (const h of holdings) {
      if (prices[h.asset.symbol] != null) continue;
      const lastTrade = [...h.trades]
        .reverse()
        .find((t) => t.status === 'COMPLETED' && t.price != null);
      if (lastTrade?.price != null) {
        prices[h.asset.symbol] = Number(lastTrade.price);
      }
    }

    return { prices, marketDate };
  }

  /** 一组取价结果里的最新行情日期；空结果为 null */
  private latestDate(fetched: { date: string }[]): string | null {
    let latest: string | null = null;
    for (const r of fetched) {
      if (r.date && (!latest || r.date > latest)) latest = r.date;
    }
    return latest;
  }

  /** 只取日期部分（当天凌晨），用于快照键与昨日查询。
   *  用本地年月日构造 UTC 0 点，避免 setHours(0,0,0,0) 在非 UTC 时区下
   *  转 UTC 后日期前移一天（Postgres @db.Date 截取 UTC 日期会错位）。 */
  private asDateOnly(d: Date): Date {
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }

  /** 写快照行（含组合配比序列化的 holdings Json） */
  private async saveSnapshot(
    portfolioId: number,
    date: Date,
    result: SnapshotResult,
    todayProfit: number,
    todayProfitRate: number,
  ) {
    const dateOnly = this.asDateOnly(date);

    await this.prisma.dailySnapshot.upsert({
      where: {
        portfolioId_date: { portfolioId, date: dateOnly },
      },
      create: {
        portfolioId,
        date: dateOnly,
        totalMarketValue: String(result.totalMarketValue),
        totalCost: String(result.totalCost),
        totalProfit: String(result.totalPnl),
        profitRate: String(result.profitRate),
        todayProfit: String(todayProfit),
        todayProfitRate: String(todayProfitRate),
        completion: String(result.completion),
        holdings: result.holdings as unknown as Prisma.InputJsonValue, // Json
      },
      update: {
        totalMarketValue: String(result.totalMarketValue),
        totalCost: String(result.totalCost),
        totalProfit: String(result.totalPnl),
        profitRate: String(result.profitRate),
        todayProfit: String(todayProfit),
        todayProfitRate: String(todayProfitRate),
        completion: String(result.completion),
        holdings: result.holdings as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** 读取某组合最新快照（不触发计算） */
  async getLatest(portfolioId: number) {
    const snap = await this.prisma.dailySnapshot.findFirst({
      where: { portfolioId },
      orderBy: { date: 'desc' },
    });
    if (!snap) return null;
    // Decimal → number，holdings Json → 结构化
    const holdings = (snap.holdings as any)?.holdings ?? snap.holdings ?? [];
    return {
      portfolioId: snap.portfolioId,
      date: snap.date,
      totalMarketValue: Number(snap.totalMarketValue),
      totalCost: Number(snap.totalCost),
      totalPnl: Number(snap.totalProfit),
      profitRate: Number(snap.profitRate),
      todayProfit: Number(snap.todayProfit),
      todayProfitRate: Number(snap.todayProfitRate),
      completion: Number(snap.completion),
      holdings,
    };
  }
}
