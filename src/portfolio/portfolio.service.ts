import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreatePortfolioDto, HoldingInput } from './dto/create-portfolio.dto';
import { UpdatePortfolioDto } from './dto/update-portfolio.dto';
import { UpdateHoldingDto } from './dto/update-holding.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { SnapshotService } from './snapshot.service';

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);
  // 服务端内存缓存：按 userId 缓存 home 响应 5s，命中时跳过 DB
  private readonly homeCache = new Map<
    string,
    { data: { portfolios: unknown[]; snapshots: unknown[] }; expiresAt: number }
  >();
  private readonly HOME_CACHE_TTL_MS = 5_000;

  constructor(
    private prisma: PrismaService,
    private snapshotService: SnapshotService,
  ) {}

  /**
   * 校验组合存在且属于当前用户，否则抛 NotFoundException。
   * 组合级资源的归属校验都走这里（防越权：用户只能操作自己的组合）。
   */
  async assertOwned(id: number, userId: string): Promise<{ id: number }> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或不属于当前用户');
    }
    return portfolio;
  }

  /** 目标配比之和必须为 100（建组合与改组合共用） */
  private assertRatioSum(holdings: HoldingInput[]) {
    const sum = holdings.reduce((acc, h) => acc + h.targetRatio, 0);
    if (Math.abs(sum - 100) > 0.01) {
      throw new BadRequestException(
        `持仓目标配比之和必须为 100，当前为 ${sum}`,
      );
    }
  }

  async create(createPortfolioDto: CreatePortfolioDto, userId: string) {
    this.assertRatioSum(createPortfolioDto.holdings);

    // 按 symbol upsert Asset：前端搜索到的标的可能尚未落库，自动建表
    const holdings = await Promise.all(
      createPortfolioDto.holdings.map(async (h) => {
        const asset = await this.prisma.asset.upsert({
          where: { symbol: h.symbol },
          create: {
            symbol: h.symbol,
            name: h.name,
            type: h.assetType,
            exchange: h.exchange,
          },
          update: { name: h.name, type: h.assetType, exchange: h.exchange }, // 名称/类型/交易所以后端最新搜索结果为准
        });
        return {
          assetId: asset.id,
          targetRatio: h.targetRatio,
          rebalanceThreshold: h.rebalanceThreshold ?? 5,
        };
      }),
    );

    await this.prisma.portfolio.create({
      data: {
        userId,
        name: createPortfolioDto.name,
        targetTotalAmount: createPortfolioDto.targetTotalAmount,
        holdings: {
          create: holdings,
        },
      },
      include: {
        holdings: true,
      },
    });
    return { message: '创建成功' };
  }

  async findAll(userId: string) {
    const res = await this.prisma.portfolio.findMany({
      where: {
        userId,
      },
    });
    return res;
  }

  /**
   * 聚合首页数据：组合列表 + 对齐的快照数组（snapshots[i] 对应 portfolios[i]）。
   * 约定：
   * - 单快照 500 记日志返 null，不影响整体；不用 catch(()=>null) 静默吞错。
   * - 若已落库快照不存在（新组合/未到 18:00 定时），则实时计算一次并落库，保证有交易就有值。
   * - 鉴权由调用方传入的 userId（来自 session）保证；无 portfolios 时返回空数组。
   * - 服务端内存缓存 5s，重复请求命中缓存跳过 DB。
   */
  async getHomeData(userId: string): Promise<{
    portfolios: unknown[];
    snapshots: unknown[];
  }> {
    const now = Date.now();
    const cached = this.homeCache.get(userId);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    });

    if (portfolios.length === 0) {
      const data = { portfolios: [], snapshots: [] };
      this.homeCache.set(userId, {
        data,
        expiresAt: now + this.HOME_CACHE_TTL_MS,
      });
      return data;
    }

    // 阶段一：并行读已持久化的快照（单条失败置 null 并记日志）
    const snapshots: unknown[] = await Promise.all(
      portfolios.map(async (p) => {
        try {
          return await this.snapshotService.getLatest(p.id);
        } catch (err) {
          this.logger.error(
            `快照读取失败 portfolioId=${p.id}`,
            err instanceof Error ? err.stack : String(err),
          );
          return null;
        }
      }),
    );

    // 阶段二：对仍为 null 的组合实时计算一次（有交易就应有值），共享预取行情
    const missingIdx = snapshots
      .map((s, i) => (s === null ? i : -1))
      .filter((i) => i !== -1);

    if (missingIdx.length > 0) {
      let prefetched: import('./snapshot.service').PrefetchedPrices | undefined;
      const missingIds = missingIdx.map((i) => portfolios[i].id);
      try {
        prefetched = await this.snapshotService.prefetchPrices(missingIds);
      } catch (err) {
        this.logger.error(
          `行情预取失败 portfolioIds=${missingIds.join(',')}`,
          err instanceof Error ? err.stack : String(err),
        );
      }

      await Promise.all(
        missingIdx.map(async (idx) => {
          const p = portfolios[idx];
          try {
            await this.snapshotService.calculateAndSave(
              p.id,
              new Date(),
              prefetched ? { prefetched } : {},
            );
            const after = await this.snapshotService.getLatest(p.id);
            snapshots[idx] = after;
          } catch (err) {
            this.logger.error(
              `快照计算失败 portfolioId=${p.id}`,
              err instanceof Error ? err.stack : String(err),
            );
            snapshots[idx] = null;
          }
        }),
      );
    }

    const data = { portfolios, snapshots };
    this.homeCache.set(userId, {
      data,
      expiresAt: now + this.HOME_CACHE_TTL_MS,
    });
    return data;
  }


  /** 组合详情（持仓骨架）。限定 userId —— 组合详情含持仓配比，不该跨用户可读
   *  组合不存在或不属于当前用户 → 404（与其它组合级端点一致，而非返回 null） */
  async findOne(id: number, userId: string) {
    await this.assertOwned(id, userId);
    return this.prisma.portfolio.findFirst({
      where: { id, userId },
      include: {
        holdings: {
          include: { asset: true },
          orderBy: { id: 'asc' },
        },
      },
    });
  }

  /**
   * 修改单条持仓的再平衡偏离阈值。
   *
   * 不触发快照重算：阈值不进快照，RebalanceNotifierService 每次判断是否提醒时
   * 都实时读 Holding.rebalanceThreshold，改完下一轮提醒即生效。
   */
  async updateHolding(
    portfolioId: number,
    holdingId: number,
    userId: string,
    updateHoldingDto: UpdateHoldingDto,
  ) {
    // 校验持仓属于该组合 + 组合属于当前用户（防越权），与录交易同一套前置检查
    const holding = await this.prisma.holding.findFirst({
      where: { id: holdingId, portfolioId, portfolio: { userId } },
      select: { id: true },
    });
    if (!holding) {
      throw new NotFoundException('持仓不存在或不属于当前用户');
    }

    return this.prisma.holding.update({
      where: { id: holdingId },
      data: {
        rebalanceThreshold: String(updateHoldingDto.rebalanceThreshold), // Decimal 转字符串
      },
      include: { asset: true }, // 形状与 findOne 里的 holdings 一致，前端可直接替换缓存
    });
  }

  /**
   * 全量修改组合：组合名 / 目标金额 / 持仓（含增删标的）。
   *
   * 持仓按 asset.symbol 做 diff —— 前端提交的是 symbol 而非 holdingId，
   * 与建组合的入参形状保持一致（新标的可能还没落库）。
   *
   * 注意：移除一个标的会连带删掉它名下所有交易（schema 的 onDelete: Cascade），
   * 该标的的历史收益就对不上了，前端须在提交前明确告知笔数。
   */
  async update(
    id: number,
    updatePortfolioDto: UpdatePortfolioDto,
    userId: string,
  ) {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id, userId },
      include: { holdings: { include: { asset: true } } },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或不属于当前用户');
    }

    const incoming = updatePortfolioDto.holdings;
    if (incoming) this.assertRatioSum(incoming);

    // 整体放进事务：配比改一半、标的删一半的中间态会让组合配比不等于 100
    await this.prisma.$transaction(async (tx) => {
      await tx.portfolio.update({
        where: { id },
        data: {
          name: updatePortfolioDto.name,
          targetTotalAmount: updatePortfolioDto.targetTotalAmount,
        },
      });

      if (!incoming) return; // 只改了组合名/金额，持仓不动

      const existingBySymbol = new Map(
        portfolio.holdings.map((h) => [h.asset.symbol, h]),
      );
      const incomingSymbols = new Set(incoming.map((h) => h.symbol));

      // 1. 不在新列表里的持仓 → 删除（级联删其交易）
      const removed = portfolio.holdings.filter(
        (h) => !incomingSymbols.has(h.asset.symbol),
      );
      if (removed.length > 0) {
        await tx.holding.deleteMany({
          where: { id: { in: removed.map((h) => h.id) } },
        });
      }

      // 2. 已有的改配比/阈值，新增的 upsert Asset 后建持仓
      for (const h of incoming) {
        const existing = existingBySymbol.get(h.symbol);
        if (existing) {
          await tx.holding.update({
            where: { id: existing.id },
            data: {
              targetRatio: h.targetRatio,
              rebalanceThreshold: h.rebalanceThreshold ?? 5,
            },
          });
          continue;
        }
        // 标的可能来自搜索接口、尚未落库；名称/类型/交易所以最新搜索结果为准
        const asset = await tx.asset.upsert({
          where: { symbol: h.symbol },
          create: {
            symbol: h.symbol,
            name: h.name,
            type: h.assetType,
            exchange: h.exchange,
          },
          update: { name: h.name, type: h.assetType, exchange: h.exchange },
        });
        await tx.holding.create({
          data: {
            portfolioId: id,
            assetId: asset.id,
            targetRatio: h.targetRatio,
            rebalanceThreshold: h.rebalanceThreshold ?? 5,
          },
        });
      }
    });

    // 配比变了偏离度就变了，重算当日快照（同录交易后的行为，强制写）
    await this.snapshotService.calculateAndSave(id).catch(() => null);

    return { message: '更新成功' };
  }

  /**
   * 删除组合。
   *
   * 硬删：持仓、交易记录、历史快照都由 schema 的 onDelete: Cascade 一并删除，
   * 不可恢复 —— 调用方须先做二次确认。
   */
  async remove(id: number, userId: string) {
    await this.assertOwned(id, userId);
    await this.prisma.portfolio.delete({ where: { id } });
    return { message: '删除成功' };
  }
}
