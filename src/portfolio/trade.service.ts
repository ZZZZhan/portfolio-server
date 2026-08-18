import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RecordTradeDto } from './dto/create-trade.dto';

@Injectable()
export class TradeService {
  constructor(private prisma: PrismaService) {}

  // TODO: 待完善 —— 场内：amount = shares × price；场外：amount = dto.amount
  // 交易方向 direction 影响份额/成本的加减
  async create(
    recordTradeDto: RecordTradeDto,
    portfolioId: number,
    userId: number,
  ) {
    // 校验：跨用户隔离 —— 这个 holding 必须属于 portfolioId，且 portfolio 属于 userId
    await this.ensureHoldingBelongsToPortfolio(
      recordTradeDto.holdingId,
      portfolioId,
      userId,
    );

    // 场内交易：后端根据份额×单价算金额；场外：用用户填的 amount
    const amount =
      recordTradeDto.type === 'EXCHANGE'
        ? (recordTradeDto.shares ?? 0) * (recordTradeDto.price ?? 0)
        : Number(recordTradeDto.amount ?? 0);

    // 场内：份额和净值都已知，直接 COMPLETED；场外：份额待日终净值确认，PENDING
    const status = recordTradeDto.type === 'EXCHANGE' ? 'COMPLETED' : 'PENDING';

    return this.prisma.trade.create({
      data: {
        holdingId: recordTradeDto.holdingId,
        type: recordTradeDto.type,
        direction: recordTradeDto.direction,
        amount: String(amount), // Decimal 转字符串
        shares: recordTradeDto.shares
          ? String(recordTradeDto.shares)
          : undefined,
        price: recordTradeDto.price ? String(recordTradeDto.price) : undefined,
        status: status as any,
      },
    });
  }

  findByUser(userId: number) {
    // TODO: 查询该用户所有组合下的交易（供列表展示）
    return this.prisma.trade.findMany({
      where: {
        holding: {
          portfolio: {
            userId,
          },
        },
      },
      include: { holding: true },
    });
  }

  // 校验交易所属的持仓，确实属于当前用户组合 —— 防越权
  private async ensureHoldingBelongsToPortfolio(
    holdingId: number,
    portfolioId: number,
    userId: number,
  ) {
    const holding = await this.prisma.holding.findFirst({
      where: {
        id: holdingId,
        portfolioId,
        portfolio: { userId },
      },
    });
    if (!holding) {
      throw new Error('持仓不存在或不属于当前用户');
    }
    return holding;
  }
}
