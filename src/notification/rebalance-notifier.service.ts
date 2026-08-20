import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  NotificationProvider,
  NotificationMessage,
  NotificationResult,
} from './notification';
import { Holding } from '../generated/prisma/client';

/**
 * 快照 holdings JSON 中单条持仓的形状（与 SnapshotService.saveSnapshot 落库一致）。
 */
interface SnapshotHolding {
  symbol: string;
  name: string;
  currentRatio: number; // 小数
  targetRatio: number; // 小数
  deviation: number; // 小数
  [k: string]: unknown;
}

/** 一条再平衡提醒项（用于拼文案） */
interface AlertItem {
  symbol: string;
  name: string;
  current: string;
  target: string;
  deviation: string;
  status: '超配' | '低配';
}

/**
 * 再平衡提醒编排：把「偏离度超过该持仓阈值」的组合推送给对应用户微信。
 *
 * 触发点：日终快照后（cron 调 notifyAll），也支持按组合单个触发。
 * 只推「配了 sendkey 的用户」；没配的静默跳过（符合降级原则）。
 *
 * 阈值用 Holding.rebalanceThreshold（%），而非快照里硬编码 5 ——
 * 用户改阈值后推送口径自动跟随。
 */
@Injectable()
export class RebalanceNotifierService {
  private readonly logger = new Logger(RebalanceNotifierService.name);

  constructor(
    private prisma: PrismaService,
    private notification: NotificationProvider,
  ) {}

  /**
   * 遍历所有配了 SendKey 的用户，检查其各组合最新快照，
   * 把有偏离超阈值持仓的组合各推一条微信。
   * 单选组合失败不中断整体。
   */
  async notifyAll(): Promise<{ notified: number; skipped: number }> {
    // 只取配了 sendkey 的用户（避免逐一查询无 key 用户）
    const users = await this.prisma.user.findMany({
      // 只取配了 sendkey 的用户；对 String? 字段 not:'' 同时排除了 null 与空串
      where: { sendkey: { not: '' } },
      select: { id: true, sendkey: true },
    });

    let notified = 0;
    let skipped = 0;
    for (const user of users) {
      const key = user.sendkey as string;
      try {
        const result = await this.notifyUser(user.id, key);
        if (result.ok) notified++;
        else skipped++;
      } catch (err) {
        this.logger.error(
          `用户 ${user.id} 再平衡提醒推送失败：${(err as Error).message}`,
        );
        skipped++;
      }
    }
    return { notified, skipped };
  }

  /**
   * 只通知某用户（组合列表下）。
   * 返回 ok=false 表示无推送/推送失败（调用方可决定是否记录）。
   */
  private async notifyUser(
    userId: string,
    sendKey: string,
  ): Promise<NotificationResult> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true, name: true },
    });
    if (portfolios.length === 0) return { ok: false, reason: '无组合' };

    // 预取这些组合的所有持仓（含 symbol / rebalanceThreshold），按 portfolioId 分组
    const holdings = await this.prisma.holding.findMany({
      where: { portfolioId: { in: portfolios.map((p) => p.id) } },
      include: { asset: true },
    });
    const holdingsByPortfolio = new Map<number, (Holding & { asset: { symbol: string; name: string } })[]>();
    for (const h of holdings) {
      const list = holdingsByPortfolio.get(h.portfolioId) ?? [];
      list.push(h);
      holdingsByPortfolio.set(h.portfolioId, list);
    }

    let sentAny = false;
    for (const p of portfolios) {
      const snap = await this.prisma.dailySnapshot.findFirst({
        where: { portfolioId: p.id },
        orderBy: { date: 'desc' },
      });
      if (!snap) continue;

      const snapHoldings = snap.holdings as unknown as SnapshotHolding[];
      if (!Array.isArray(snapHoldings)) continue;

      // 超阈值项：用 Holding.rebalanceThreshold 判断
      const alerts = this.pickAlerts(
        p.id,
        holdingsByPortfolio.get(p.id) ?? [],
        snapHoldings,
      );
      if (alerts.length === 0) continue;

      const message: NotificationMessage = {
        title: `再平衡提醒：${p.name}`,
        desp: this.buildDesp(p.name, Number(snap.totalMarketValue), alerts),
      };
      const r = await this.notification.send(sendKey, message);
      if (r.ok) {
        this.logger.log(`已推送再平衡提醒：${p.name}（${alerts.length} 项）`);
        sentAny = true;
      }
    }
    return { ok: sentAny, reason: sentAny ? undefined : '无超阈值项或推送失败' };
  }

  /** 挑出偏离超阈值的持仓 */
  private pickAlerts(
    portfolioId: number,
    holdings: (Holding & { asset: { symbol: string; name: string } })[],
    snap: SnapshotHolding[],
  ): AlertItem[] {
    const thresholdBySymbol = new Map(
      holdings.map((h) => [h.asset.symbol, Number(h.rebalanceThreshold)]),
    );
    const alerts: AlertItem[] = [];
    for (const h of snap) {
      const threshold = thresholdBySymbol.get(h.symbol) ?? 5;
      const devPct = Math.abs(h.deviation) * 100;
      if (devPct <= threshold) continue;
      alerts.push({
        symbol: h.symbol,
        name: h.name,
        current: `${(h.currentRatio * 100).toFixed(1)}%`,
        target: `${(h.targetRatio * 100).toFixed(1)}%`,
        deviation: `${(h.deviation * 100).toFixed(1)}%`,
        status: h.deviation > 0 ? '超配' : '低配',
      });
    }
    return alerts;
  }

  /** 拼 Markdown 正文（微信需要换行。Server酱 desp 支持 Markdown） */
  private buildDesp(
    portfolioName: string,
    totalMarketValue: number | string,
    alerts: AlertItem[],
  ): string {
    const rows = alerts
      .map(
        (a) =>
          `- **${a.name}**（${a.symbol}）\`${a.status} ${a.deviation}\` 当前 ${a.current} / 目标 ${a.target}`,
      )
      .join('\n');
    return (
      `**组合**：${portfolioName}\n\n` +
      `**当前市值**：¥${Number(totalMarketValue).toLocaleString('en-US')}\n\n` +
      `**以下持仓偏离目标配比超过阈值，建议再平衡**：\n\n${rows}\n\n` +
      `> 来自投资组合助手`
    );
  }
}