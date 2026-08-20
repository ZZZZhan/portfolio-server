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
  currentRatio: number; // 当前配比：建仓完成后 = 市值/总市值（再平衡口径）；未完成置 0（不提醒）
  targetRatio: number; // 目标占比（小数，如 0.3 = 30%）
  deviation: number; // 偏离 = currentRatio - targetRatio；建仓未完成置 0（不提醒再平衡）
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

  // 3. 组合汇总（需先算 totalCost / completion，再决定 currentRatio 口径）
  //    累计投入成本（已完成交易的买入总额）—— 用于 completion 和 profitRate
  const totalCost = totalBuyAmountForAll(input.holdings);
  // completion 内部用真实值计算（可 >1，如场内一手导致注投入略超目标），
  // 供 isRebalancePhase 判定建仓是否完成（>=100%）；
  // 对外返回/落库时封顶为 1（见函数末尾），展示上不超过 100%。
  const completion = input.targetTotalAmount > 0 ? totalCost / input.targetTotalAmount : 0;

  // 4. 当前配比与偏离 —— 按建仓阶段切换口径：
  //    - 建仓未完成（completion < 100%）：不提醒偏离，currentRatio/deviation 置 0
  //      （此时若按市值占比会假性达标；按目标总额会全员低配——都无再平衡意义）
  //    - 建仓完成（completion >= 100%）：用实际市值占比 marketValue/totalMarketValue
  //      整体同比例涨跌时配比关系不变、偏离≈0，只有真正配比失衡才提醒再平衡
  const isRebalancePhase = completion >= 1;
  for (const h of holdingResults) {
    if (isRebalancePhase) {
      h.currentRatio = totalMarketValue > 0 ? h.marketValue / totalMarketValue : 0;
      h.deviation = h.currentRatio - h.targetRatio;
    } else {
      h.currentRatio = 0;
      h.deviation = 0;
    }
  }

  // 5. 累计盈亏 = 所有持仓的（已实现 + 浮动）
  const totalPnl = holdingResults.reduce(
    (s, h) => s + h.realizedPnl + h.unrealizedPnl,
    0,
  );
  const profitRate = totalCost > 0 ? totalPnl / totalCost : 0;

  return {
    portfolioId: input.portfolioId,
    totalMarketValue,
    totalCost,
    totalPnl,
    profitRate,
    // 对外暴露的建仓完成度封顶 100%（内部 isRebalancePhase 判定已用真实 completion 完成）
    completion: Math.min(completion, 1),
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