import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RecordTradeDto } from './dto/create-trade.dto';
import { SnapshotService } from './snapshot.service';

/**
 * 录入交易返回。
 * - 场内交易录完立即触发快照计算，snapshot 有值
 * - 场外交易份额待净值确认（PENDING），不触发快照，snapshot 为 null
 */
export interface RecordTradeResult {
  trade: {
    id: number;
    holdingId: number;
    type: string;
    direction: string;
    amount: string;
    shares: string | null;
    price: string | null;
    status: string;
    tradedAt: Date;
  };
  snapshot: unknown | null;
}

@Injectable()
export class TradeService {
  constructor(
    private prisma: PrismaService,
    private snapshotService: SnapshotService,
  ) {}

  /**
   * 录入交易（针对已有持仓）。
   * 标的由 holdingId 指定，组合的目标配置在建组合时已定好，
   * 这里不新增标的/持仓，避免破坏配比和=100% 的语义。
   */
  async create(
    dto: RecordTradeDto,
    holdingId: number,
    portfolioId: number,
    userId: number,
  ): Promise<RecordTradeResult> {
    // 1. 校验持仓属于该组合 + 组合属于当前用户（防越权）
    const holding = await this.prisma.holding.findFirst({
      where: {
        id: holdingId,
        portfolioId,
        portfolio: { userId },
      },
    });
    if (!holding) {
      throw new NotFoundException('持仓不存在或不属于当前用户');
    }

    // 2. 算金额 + 份额 + 状态
    //    场内：金额 = 份额 × 单价，状态 COMPLETED
    //    场外填了净值（补录历史）：份额 = 金额 / 净值，状态 COMPLETED
    //    场外未填净值（今天申购）：份额待定，状态 PENDING
    let shares: number | undefined;
    let price: number | undefined;
    let amount: number;
    let status: 'COMPLETED' | 'PENDING';

    if (dto.type === 'EXCHANGE') {
      shares = dto.shares;
      price = dto.price;
      amount = (shares ?? 0) * (price ?? 0);
      status = 'COMPLETED';
    } else {
      // 场外
      amount = Number(dto.amount ?? 0);
      if (dto.navPrice != null) {
        // 补录历史：净值已知，折算份额
        price = dto.navPrice;
        shares = amount / dto.navPrice;
        status = 'COMPLETED';
      } else {
        // 今天申购：净值未出
        price = undefined;
        shares = undefined;
        status = 'PENDING';
      }
    }

    // 4. 落交易
    const trade = await this.prisma.trade.create({
      data: {
        holdingId,
        type: dto.type,
        direction: dto.direction,
        amount: String(amount), // Decimal 转字符串
        shares: shares != null ? String(shares) : undefined,
        price: price != null ? String(price) : undefined,
        status: status as any,
      },
    });

    // 5. 触发快照：
    //    - COMPLETED（场内 或 场外补录历史）→ 立即计算（份额已知）
    //    - PENDING（场外今天申购）→ 不计算，等 18:00 cron 补净值后重算
    let snapshot: unknown | null = null;
    if (status === 'COMPLETED') {
      snapshot = await this.snapshotService
        .calculateAndSave(portfolioId)
        .catch(() => null);
    }

    return {
      trade: {
        id: trade.id,
        holdingId: trade.holdingId,
        type: trade.type,
        direction: trade.direction,
        amount: String(trade.amount),
        shares: trade.shares != null ? String(trade.shares) : null,
        price: trade.price != null ? String(trade.price) : null,
        status: trade.status,
        tradedAt: trade.tradedAt,
      },
      snapshot,
    };
  }

  /** 查某组合下的交易（含持仓+标的，供交易列表展示） */
  findByPortfolio(portfolioId: number, userId: number) {
    return this.prisma.trade.findMany({
      where: { holding: { portfolioId, portfolio: { userId } } },
      include: { holding: { include: { asset: true } } },
      orderBy: { tradedAt: 'desc' },
    });
  }
}
