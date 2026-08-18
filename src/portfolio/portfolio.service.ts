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
    await this.prisma.portfolio.create({
      data: {
        userId,
        name: createPortfolioDto.name,
        targetTotalAmount: createPortfolioDto.targetTotalAmount,
        holdings: {
          create: createPortfolioDto.holdings.map((h) => ({
            assetId: h.assetId,
            targetRatio: h.targetRatio,
            rebalanceThreshold: h.rebalanceThreshold ?? 5,
          })),
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
    return `This action returns a #${id} portfolio`;
  }

  update(id: number, updatePortfolioDto: UpdatePortfolioDto) {
    return `This action updates a #${id} portfolio`;
  }

  remove(id: number) {
    return `This action removes a #${id} portfolio`;
  }
}
