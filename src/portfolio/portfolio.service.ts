import { BadRequestException, Injectable } from '@nestjs/common';
import { CreatePortfolioDto } from './dto/create-portfolio.dto';
import { UpdatePortfolioDto } from './dto/update-portfolio.dto';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class PortfolioService {
  constructor(private prisma: PrismaService) {}
  async create(createPortfolioDto: CreatePortfolioDto, userId: number) {
    const sum = createPortfolioDto.holdings.reduce(
      (acc, h) => acc + h.targetRatio,
      0,
    );
    if (Math.abs(sum - 100) > 0.01) {
      throw new BadRequestException(
        `持仓目标配比之和必须为 100，当前为 ${sum}`,
      );
    }

    // 按 symbol upsert Asset：前端搜索到的标的可能尚未落库，自动建表
    const holdings = await Promise.all(
      createPortfolioDto.holdings.map(async (h) => {
        const asset = await this.prisma.asset.upsert({
          where: { symbol: h.symbol },
          create: { symbol: h.symbol, name: h.name, type: h.assetType, exchange: h.exchange },
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

  async findAll(userId: number) {
    const res = await this.prisma.portfolio.findMany({
      where: {
        userId,
      },
    });
    return res;
  }

  findOne(id: number) {
    return this.prisma.portfolio.findUnique({
      where: { id },
      include: {
        holdings: {
          include: { asset: true },
          orderBy: { id: 'asc' },
        },
      },
    });
  }

  update(id: number, updatePortfolioDto: UpdatePortfolioDto) {
    return `This action updates a #${id} portfolio`;
  }

  remove(id: number) {
    return `This action removes a #${id} portfolio`;
  }
}
