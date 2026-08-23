import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { SnapshotService } from './snapshot.service';
import { PriceProvider, PriceQuery } from '../price-provider/price-provider';
import { RebalanceNotifierService } from '../notification/rebalance-notifier.service';
import {
  AdvisoryLockService,
  LOCK_KEYS,
} from '../common/advisory-lock.service';

/**
 * 快照调度（@nestjs/schedule）。
 *
 * 三个触发点（SPEC）：
 *  - 18:00  日终快照：遍历所有组合，拉收盘价算并写当日 DailySnapshot。
 *           onlyIfMarketToday=true：非交易日（行情日期 != 今天）则不写，
 *           避免周末/假期写占位行干扰“最近交易日”判断。
 *  - 22:00  补场外份额：找所有 PENDING 场外交易（不管哪天），
 *           用最新已公布净值折算份额、置 COMPLETED，并重算受影响组合快照。
 *           幂等、可重入 —— T+2 的 QDII 在净值公布当天自然被补上。
 *           补完后推送一次再平衡提醒（配了 SendKey 的用户）。
 *  - 启动   OnApplicationBootstrap：补跑。遍历组合，若最新快照日期早于最近一个
 *           工作日（周一~周五，节假日无法精确判断、由 onlyIfMarketToday 兜底）则补算。
 *
 * 注意：所有方法捕获异常并记日志，单组合/单交易失败不拖垮整个调度。
 *
 * 多实例：@nestjs/schedule 是进程内定时器，扩容后每个实例都会到点触发。
 * 三个入口都用 advisory lock 抢占，只有拿到锁的实例真正执行 —— 快照虽是
 * 同组合同日 upsert（幂等），但再平衡微信推送重复发用户就会收到多条。
 */
@Injectable()
export class SnapshotCronService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SnapshotCronService.name);

  constructor(
    private prisma: PrismaService,
    private snapshotService: SnapshotService,
    private priceProvider: PriceProvider,
    private rebalanceNotifier: RebalanceNotifierService,
    private lock: AdvisoryLockService,
  ) {}

  /** 每交易日 18:00：拉收盘价 → 写当日快照 */
  @Cron('0 0 18 * * *')
  async dailySnapshot() {
    await this.lock.runExclusive(
      LOCK_KEYS.dailySnapshot,
      '18:00 日终快照',
      () => this.runDailySnapshot(),
    );
  }

  private async runDailySnapshot() {
    this.logger.log('18:00 日终快照开始');
    const portfolios = await this.prisma.portfolio.findMany({
      select: { id: true, name: true },
    });
    let written = 0;
    for (const p of portfolios) {
      try {
        const r = await this.snapshotService.calculateAndSave(
          p.id,
          new Date(),
          { onlyIfMarketToday: true },
        );
        if (r.written) written++;
        else this.logger.debug(`组合 ${p.id} 非交易日/行情未收盘，跳过`);
      } catch (err) {
        this.logger.error(`组合 ${p.id} 快照失败：${(err as Error).message}`);
      }
    }
    this.logger.log(`18:00 日终快照完成，写入 ${written}/${portfolios.length}`);
  }

  /** 每交易日 22:00：补全所有 PENDING 场外交易份额 + 重算受影响组合快照 */
  @Cron('0 0 22 * * *')
  async settleOtcTrades() {
    await this.lock.runExclusive(
      LOCK_KEYS.settleOtcTrades,
      '22:00 补场外份额',
      () => this.runSettleOtcTrades(),
    );
  }

  private async runSettleOtcTrades() {
    this.logger.log('22:00 补场外份额开始');
    const affected = await this.settlePendingTrades();
    for (const portfolioId of affected) {
      try {
        await this.snapshotService.calculateAndSave(portfolioId, new Date(), {
          onlyIfMarketToday: true,
        });
      } catch (err) {
        this.logger.error(
          `补场外后重算组合 ${portfolioId} 失败：${(err as Error).message}`,
        );
      }
    }
    this.logger.log(`22:00 补场外完成，影响 ${affected.size} 个组合`);
    // 份额确认并重算快照后再推送一次再平衡提醒（配了 SendKey 的用户才会收到）
    try {
      const r = await this.rebalanceNotifier.notifyAll();
      this.logger.log(
        `再平衡提醒推送完成，送达 ${r.notified} 个用户，跳过 ${r.skipped}`,
      );
    } catch (err) {
      this.logger.error(`再平衡提醒推送异常：${(err as Error).message}`);
    }
  }

  /**
   * 结算所有 PENDING 场外交易：用最新已公布净值折算份额，置 COMPLETED。
   * 幂等、可重入 —— 已 COMPLETED 的不参与，拿不到净值的保持 PENDING（T+2 等下次再补）。
   * @returns 受影响的 portfolioId 集合
   */
  private async settlePendingTrades(): Promise<Set<number>> {
    const affected = new Set<number>();

    // 找所有 PENDING 的场外交易（holding.asset.type=FUND / exchange=OTC）
    const pending = await this.prisma.trade.findMany({
      where: {
        status: 'PENDING',
        holding: { asset: { type: 'FUND' } },
      },
      include: {
        holding: {
          include: { portfolio: { select: { id: true } }, asset: true },
        },
      },
    });
    if (pending.length === 0) return affected;

    // 批量取这些标的的净值
    const queries: PriceQuery[] = pending
      .map((t) => t.holding.asset)
      .filter((a, i, arr) => arr.findIndex((x) => x.symbol === a.symbol) === i)
      .map((a) => ({ symbol: a.symbol, exchange: a.exchange }));
    const fetched = await this.priceProvider.getPrices(queries);
    const navMap = new Map(fetched.map((r) => [r.symbol, r]));

    for (const t of pending) {
      const nav = navMap.get(t.holding.asset.symbol);
      // 拿不到净值（如 T+2 未公布）→ 保持 PENDING，等下次 cron
      if (!nav) continue;

      const amount = Number(t.amount);
      const shares = amount / nav.price;
      await this.prisma.trade.update({
        where: { id: t.id },
        data: {
          shares: String(shares),
          price: String(nav.price),
          status: 'COMPLETED',
        },
      });
      affected.add(t.holding.portfolio.id);
      this.logger.log(
        `补场外份额 trade=${t.id} symbol=${t.holding.asset.symbol} ` +
          `amount=${amount} nav=${nav.price} shares=${shares}`,
      );
    }

    return affected;
  }

  /** 启动补跑：组合最新快照日期早于最近工作日则补算一次 */
  async onApplicationBootstrap() {
    // 多实例同时部署时只让一个实例补跑；抢不到的实例跳过即可，数据是共享的
    await this.lock.runExclusive(LOCK_KEYS.startupBackfill, '启动补跑', () =>
      this.runStartupBackfill(),
    );
  }

  private async runStartupBackfill() {
    this.logger.log('启动补跑检查');
    const portfolios = await this.prisma.portfolio.findMany({
      select: { id: true, name: true },
    });
    const lastTradeDay = this.lastTradeDay();
    let backfilled = 0;
    for (const p of portfolios) {
      try {
        const latest = await this.prisma.dailySnapshot.findFirst({
          where: { portfolioId: p.id },
          orderBy: { date: 'desc' },
        });
        if (latest && this.asDateOnly(latest.date) >= lastTradeDay) continue; // 已有最近交易日快照

        const r = await this.snapshotService.calculateAndSave(
          p.id,
          new Date(),
          { onlyIfMarketToday: true },
        );
        if (r.written) {
          backfilled++;
          this.logger.log(`补跑组合 ${p.id} (${p.name})`);
        }
      } catch (err) {
        this.logger.error(`补跑组合 ${p.id} 失败：${(err as Error).message}`);
      }
    }
    if (backfilled > 0)
      this.logger.log(`启动补跑完成，补算 ${backfilled} 个组合`);
  }

  /** 最近一个工作日（跳过周六日，节假日无法判断、由 onlyIfMarketToday 兜底）。
   *  返回 UTC 0 点 Date，与 SnapshotService.asDateOnly 口径一致。 */
  private lastTradeDay(): Date {
    const d = new Date();
    const day = d.getDay();
    let offset = 0;
    if (day === 0)
      offset = -2; // 周日 → 上周五
    else if (day === 6) offset = -1; // 周六 → 上周五
    const target = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() + offset,
    );
    return new Date(
      Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()),
    );
  }

  /** 与 SnapshotService.asDateOnly 同口径（本地年月日 → UTC 0 点） */
  private asDateOnly(d: Date): Date {
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }
}
