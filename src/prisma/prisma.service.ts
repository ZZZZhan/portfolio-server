import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { getPrismaAdapter } from '../lib/prisma';
import 'dotenv/config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    // 复用 lib/prisma 的共享 adapter（与 better-auth 实例共用同一个连接池）
    super({ adapter: getPrismaAdapter() });
  }

  async onModuleInit() {
    await this.$connect();
  }
}
