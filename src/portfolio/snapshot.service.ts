import { Injectable } from '@nestjs/common';
import { Prisma, Exchange } from '../generated/prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PriceProvider } from '../price-provider/price-provider';
import {
  computeSnapshot,
  SnapshotResult,
  TradeInput,
} from './calc';

@Injectable()
export class SnapshotService {
  constructor(
    private prisma: PrismaService,
    private priceProvider: PriceProvider, // 行情源，可注入替换（Sina / 未来 Tencent / 测试 fake）
  ) {}

  /** 计算某组合的当日快照并写入 DailySnapshot（同组合同日 upsert） */
  async calculateAndSave(
    portfolioId: number,
    date = new Date(),
  ): Promise<SnapshotResult> {
    // 1. 查组合（含 targetTotalAmount）
    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: portfolioId },
    });
    if (!portfolio) throw new Error(`组合不存在: ${portfolioId}`);

    // 2. 查该组合所有持仓，含标的 + 交易（约定按 tradedAt 升序）
    const holdings = await this.prisma.holding.findMany({
      where: { portfolioId },
      include: { asset: true, trades: { orderBy: { tradedAt: 'asc' } } },
    });

    // 3. 批量取价（行情源），组装 symbol → price 映射
    const prices = await this.fetchPrices(holdings);

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

    // 7. 写入 DailySnapshot（同组合 + 指定日期 upsert）
    await this.saveSnapshot(portfolioId, date, result, todayProfit, todayProfitRate);

    return result;
  }

  /**
   * 批量取价并构造成 { symbol: price }。
   * 源返回不了的标的走降级兜底：
   *   1. 该标的最近一次 COMPLETED 成交价/净值（trade.price）
   *   2. 仍无 → 0（市值视为 0）
   * 对齐 SPEC 第 12 条：行情源不可用时服务仍可用，不抛错。
   */
  private async fetchPrices(
    holdings: {
      asset: { symbol: string; exchange: Exchange };
      trades: { price: Prisma.Decimal | null; status: string }[];
    }[],
  ): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};

    // 行情源取价
    const fetched = await this.priceProvider.getPrices(
      holdings.map((h) => ({
        symbol: h.asset.symbol,
        exchange: h.asset.exchange,
      })),
    );
    for (const r of fetched) prices[r.symbol] = r.price;

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

    return prices;
  }

  /** 只取日期部分（当天凌晨），用于快照键与昨日查询 */
  private asDateOnly(d: Date): Date {
    const dateOnly = new Date(d);
    dateOnly.setHours(0, 0, 0, 0);
    return dateOnly;
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