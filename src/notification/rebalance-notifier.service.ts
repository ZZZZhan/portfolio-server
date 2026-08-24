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
   * 遍历所有配了 SendKey 的用户，逐个检查其各组合最新快照，
   * 把有偏离超阈值持仓的组合各推一条微信。
   * 单选用户/组合失败不中断整体（降级）。
   *
   * 流程：捞全量配了 key 的用户 → 逐用户调 notifyUser → 统计成功/跳过。
   * @returns { notified, skipped } 仅用于日志，不抛错。
   */
  async notifyAll(): Promise<{ notified: number; skipped: number }> {
    // 只取配了 sendkey 的用户（避免逐一无 key 用户查询）；not:'' 同时排除 null 与空串
    const users = await this.prisma.user.findMany({
      where: { sendkey: { not: '' } },
      select: { id: true, sendkey: true },
    });

    let notified = 0;
    let skipped = 0;
    for (const user of users) {
      const key = user.sendkey as string;
      try {
        // 每个用户独立处理：看他的所有组合，有超阈值才真正发微信
        const result = await this.notifyUser(user.id, key);
        if (result.ok) notified++;
        else skipped++; // 无组合 / 无超阈值 / 发送失败都算跳过
      } catch (err) {
        // 单个用户异常不拖垮整体：记日志后继续下一个
        this.logger.error(
          `用户 ${user.id} 再平衡提醒推送失败：${(err as Error).message}`,
        );
        skipped++;
      }
    }
    return { notified, skipped };
  }

  /**
   * 处理单个用户：看他的所有组合的最近一条快照，
   * 凡是有持仓偏离超阈值，就给这个用户发一条微信。
   * 名字带 Id 表示它是 notifyAll 的内部助手（按 userId 处理）。
   *
   * @returns ok=true 表示这个用户至少发出一条；ok=false 表示
   *          无组合 / 无超阈值项 / 发送失败（调用方按“跳过”处理）。
   */
  private async notifyUser(
    userId: string,
    sendKey: string,
  ): Promise<NotificationResult> {
    // A. 只处理这一个用户的组合（不含别人的）
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true, name: true },
    });
    if (portfolios.length === 0) return { ok: false, reason: '无组合' };

    // B. 一次预取该用户所有组合的全部持仓（含 symbol / rebalanceThreshold），
    //    按 portfolioId 分组存进 Map。后面每个组合都要按 symbol 查阈值，
    //    提前分好组省得对每个组合重复查库。
    const holdings = await this.prisma.holding.findMany({
      where: { portfolioId: { in: portfolios.map((p) => p.id) } },
      include: { asset: true },
    });
    const holdingsByPortfolio = new Map<
      number,
      (Holding & { asset: { symbol: string; name: string } })[]
    >();
    for (const h of holdings) {
      const list = holdingsByPortfolio.get(h.portfolioId) ?? [];
      list.push(h);
      holdingsByPortfolio.set(h.portfolioId, list);
    }

    let sentAny = false; // 该用户今天是否至少真实发出了一条
    for (const p of portfolios) {
      // C. 每个组合只看最近一条快照（偏离度是快照时算好的，读最新即可）
      const snap = await this.prisma.dailySnapshot.findFirst({
        where: { portfolioId: p.id },
        orderBy: { date: 'desc' },
      });
      if (!snap) continue; // 还没算过快照 / 格式异常都跳过

      const snapHoldings = snap.holdings as unknown as SnapshotHolding[];
      if (!Array.isArray(snapHoldings)) continue; // 快照里没有 holdings 数组，跳过

      // E. 挑出偏离超阈值的持仓；一个都没有就不用推这个组合
      const alerts = this.pickAlerts(
        p.id,
        holdingsByPortfolio.get(p.id) ?? [],
        snapHoldings,
      );
      if (alerts.length === 0) continue;

      // F. 拼一条微信（组合名 + 超阈值持仓明细），真正发出去
      const message: NotificationMessage = {
        title: `再平衡提醒：${p.name}`,
        desp: this.buildDesp(p.name, Number(snap.totalMarketValue), alerts),
      };
      const r = await this.notification.send(sendKey, message);
      if (r.ok) {
        this.logger.log(`已推送再平衡提醒：${p.name}（${alerts.length} 项）`);
        sentAny = true;
      }
      // 发送失败：r.ok=false，不 set sentAny，最终该用户按本次跳过计
    }
    return {
      ok: sentAny,
      reason: sentAny ? undefined : '无超阈值项或推送失败',
    };
  }

  /**
   * 从一条快照的持仓里，挑出“偏离度超过该持仓阈值”的项。
   *
   * - 阈值来自 Holding.rebalanceThreshold（百分数），按标的 symbol 匹配；
   *   快照 JSON 里没存阈值，所以用预取的 holdings 做 { symbol -> 阈值% } 查找。
   * - 偏离度 deviation 是小数（如 0.08=8%），乘 100 再跟阈值比。
   * - deviation>0 = 当前配比高于目标 = 超配；反之为低配。
   */
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

  /**
   * 把“某组合 + 超阈值持仓明细”拼成微信正文（Markdown 格式，
   * Server酱 的 desp 支持 Markdown 渲染）。每行一条超阈值项：
   * 含状态（超配/低配）、偏离度、当前 vs 目标配比。
   */
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
