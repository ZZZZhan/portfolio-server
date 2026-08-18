// src/portfolio/calc.ts
// 计算引擎核心 —— 纯函数，无副作用（不碰数据库），便于单测

export interface TradeInput {
  type: 'EXCHANGE' | 'OTC';
  direction: 'BUY' | 'SELL';
  amount: number; // 金额（元）
  shares: number | null; // 份额（场外 PENDING 可能为 null）
  price: number | null; // 单价/净值
  status: 'COMPLETED' | 'PENDING';
}

export interface HoldingResult {
  symbol: string;
  name: string;
  currentShares: number; // 当前份额
  avgCost: number; // 成本均价
  holdingCost: number; // 持仓成本
  marketValue: number; // 市值
  realizedPnl: number; // 已实现盈亏
  unrealizedPnl: number; // 浮动盈亏（未实现）
  currentRatio: number; // 当前占比（小数，如 0.25 = 25%）
  targetRatio: number; // 目标占比（小数，如 0.3 = 30%）
  deviation: number; // 偏离 = currentRatio - targetRatio
}

export interface SnapshotResult {
  portfolioId: number;
  totalMarketValue: number;
  totalCost: number; // 累计投入成本（Σ买入金额）
  totalPnl: number; // 累计盈亏（已实现 + 浮动）
  profitRate: number; // 累计收益率
  completion: number; // 建仓完成度（小数，如 0.0125 = 1.25%）
  holdings: HoldingResult[];
}

interface CreateSnapshotInput {
  portfolioId: number;
  targetTotalAmount: number;
  holdings: {
    symbol: string;
    name: string;
    targetRatio: number; // 目标配比（小数，如 0.3 = 30%）
    price: number; // 最新价（M1 假价格传入）
    trades: TradeInput[];
  }[];
}

// 只统计份额已确认的交易（场外 PENDING 份额为 null，不参与计算）
function isEffective(t: TradeInput): boolean {
  return t.status === 'COMPLETED' && t.shares != null && t.price != null;
}

export function computeSnapshot(input: CreateSnapshotInput): SnapshotResult {
  // 1. 先算每个持仓的独立结果（成本/市值/盈亏）
  const holdingResults: HoldingResult[] = input.holdings.map((h) => {
    // 仅份额已确认的交易，按时间顺序处理（trades 需已按 tradedAt 排序）
    const effective = h.trades.filter(isEffective);

    let totalBuyAmount = 0; // 累计买入金额
    let totalBuyShares = 0; // 累计买入份额
    let totalSellShares = 0; // 累计卖出份额
    let realizedPnl = 0; // 已实现盈亏

    for (const t of effective) {
      if (t.direction === 'BUY') {
        totalBuyAmount += t.amount;
        totalBuyShares += t.shares!;
      } else {
        // SELL：卖出前用当前成本均价计算该笔已实现盈亏
        const avgCostBefore = totalBuyShares > 0 ? totalBuyAmount / totalBuyShares : 0;
        realizedPnl += (t.price! - avgCostBefore) * t.shares!;
        totalSellShares += t.shares!;
      }
    }

    const currentShares = totalBuyShares - totalSellShares;
    const avgCost = totalBuyShares > 0 ? totalBuyAmount / totalBuyShares : 0;
    const holdingCost = avgCost * currentShares;
    const marketValue = currentShares * h.price;
    const unrealizedPnl = marketValue - holdingCost;

    return {
      symbol: h.symbol,
      name: h.name,
      currentShares,
      avgCost,
      holdingCost,
      marketValue,
      realizedPnl,
      unrealizedPnl,
      currentRatio: 0, // 依赖总市值，第二步算
      targetRatio: h.targetRatio,
      deviation: 0, // 依赖 currentRatio，第二步算
    };
  });

  // 2. 组合总市值（各持仓市值之和）
  const totalMarketValue = holdingResults.reduce((s, h) => s + h.marketValue, 0);

  // 3. 用总市值回填每个持仓的占比和偏离
  for (const h of holdingResults) {
    h.currentRatio = totalMarketValue > 0 ? h.marketValue / totalMarketValue : 0;
    h.deviation = h.currentRatio - h.targetRatio;
  }

  // 4. 组合汇总
  // 累计投入成本（已完成交易的买入总额）—— 用于 completion 和 profitRate
  const totalCost = totalBuyAmountForAll(input.holdings);
  // 累计盈亏 = 所有持仓的（已实现 + 浮动）
  const totalPnl = holdingResults.reduce(
    (s, h) => s + h.realizedPnl + h.unrealizedPnl,
    0,
  );
  const profitRate = totalCost > 0 ? totalPnl / totalCost : 0;
  const completion = input.targetTotalAmount > 0 ? totalCost / input.targetTotalAmount : 0;

  return {
    portfolioId: input.portfolioId,
    totalMarketValue,
    totalCost,
    totalPnl,
    profitRate,
    completion,
    holdings: holdingResults,
  };
}

// 组合层面累计投入本金 = Σ 各持仓已完成买入金额
function totalBuyAmountForAll(
  holdings: CreateSnapshotInput['holdings'],
): number {
  let sum = 0;
  for (const h of holdings) {
    for (const t of h.trades) {
      if (t.status === 'COMPLETED' && t.direction === 'BUY') {
        sum += t.amount;
      }
    }
  }
  return sum;
}