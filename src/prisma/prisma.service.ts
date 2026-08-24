import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { getPrismaAdapter, disposePrismaAdapter } from '../lib/prisma';
import 'dotenv/config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // 复用 lib/prisma 的共享 adapter（与 better-auth 实例共用同一个连接池）
    super({ adapter: getPrismaAdapter() });
  }

  async onModuleInit() {
    await this.$connect();
  }

  /** 测试/优雅停机时断开连接池，否则 pg 连接一直保持 Node 事件循环活跃 */
  async onModuleDestroy() {
    await this.$disconnect();
    // Prisma 7 driver adapters：$disconnect 不关闭 adapter 的 pg 池，需显式 dispose
    await disposePrismaAdapter();
  }
}
