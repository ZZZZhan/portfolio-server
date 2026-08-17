import { Injectable } from '@nestjs/common';
import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from './prisma/prisma.service';
@Injectable()
export class AppService {
  constructor(private prisma: PrismaService) {}
  async getHello() {
    // 读 probe 表第一行，没有就返回一个提示
    const row = await this.prisma.probe.findFirst();
    return row ?? { message: 'probe 表是空的，先插入一行数据' };
  }
}
