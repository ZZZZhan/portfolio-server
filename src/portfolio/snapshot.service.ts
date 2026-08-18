import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  computeSnapshot,
  SnapshotResult,
  TradeInput,
} from './calc';

/** 假价格表（M1 写死，M4 换真实行情源） */
export const FAKE_PRICES: Record<string, number> = {
  '510300': 3.5, // 沪深300ETF
  '513100': 1.2, // 标普500ETF
  '159915': 1.8, // 创业板ETF
  '511260': 1.5, // 债券基金
};

@Injectable()
export class SnapshotService {
  constructor(private prisma: PrismaService) {}

  /** 计算某组合的当日快照并写入 DepotSnapshot（同组合同日 upsert） */
  async calculateAndSave(portfolioId: number, date = new Date()): Promise<SnapshotResult> {
    // 1. 查组合（含 targetTotalAmount）
    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: portfolioId },
    });
    if (!portfolio) throw new Error(`组合不存在: ${portfolioId}`);

    // 2. 查该组合所有持仓，含标的 + 交易（A 门于组装 calc 输入）
    const holdings = await this.prisma.holding.findMany({
      where: { portfolioId },
      include: { asset: true, trades: { orderBy: { tradedAt: 'asc' } } },
    });

    // 3. 组装 computeSnapshot 输入
    const input = {
      portfolioId,
      targetTotalAmount: Number(portfolio.targetTotalAmount),
      holdings: holdings.map((h) => ({
        symbol: h.asset.symbol,
        name: h.asset.name,
        targetRatio: h.targetRatio / 100, // 25 → 0.25
        price: FAKE_PRICES[h.asset.symbol] ?? 0, // 假价格，缺则 0
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

    // 4. 纯函数计算
    const result = computeSnapshot(input);

    // 5. 写入 DailySnapshot（同组合 + 当天 upsert）
    await this.saveSnapshot(portfolioId, date, result);

    return result;
  }

  /** 写快照行（含帮符号配比序列化的 holdings Json） */
  private async saveSnapshot(
    portfolioId: number,
    date: Date,
    result: SnapshotResult,
  ) {
    const dateOnly = new Date(date);
    dateOnly.setHours(0, 0, 0, 0); // 只取日期部分

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
        todayProfit: '0', // M1 暂不填今日收益（需昨日快照）
        todayProfitRate: '0',
        completion: String(result.completion),
        holdings: result.holdings as unknown as Prisma.InputJsonValue, // Json
      },
      update: {
        totalMarketValue: String(result.totalMarketValue),
        totalCost: String(result.totalCost),
        totalProfit: String(result.totalPnl),
        profitRate: String(result.profitRate),
        completion: String(result.completion),
        holdings: result.holdings as unknown as Prisma.InputJsonValue,
      },
    });
  }
}